use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::config::ConfigState;
use crate::logutil::sys_line;
use crate::process::no_window;

#[derive(Debug, Clone, Serialize, Default)]
pub struct GitInfo {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: bool,
}

pub(crate) fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    no_window(&mut cmd);
    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// `rev-list --left-right --count HEAD...@{u}` 출력 "ahead\tbehind" 파싱.
pub fn parse_ahead_behind(output: &str) -> (u32, u32) {
    let mut parts = output.trim().split_whitespace();
    let ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

fn cwd_for(app: &AppHandle, id: &str) -> Result<String, String> {
    app.state::<ConfigState>()
        .0
        .lock()
        .unwrap()
        .services
        .iter()
        .find(|s| s.id == id)
        .map(|s| s.cwd.clone())
        .ok_or_else(|| format!("unknown service {id}"))
}

/// cwd 미설정 서비스는 git 명령을 아예 실행하지 않고 "정보 없음"(branch="?") 상태를 바로 돌려준다 -
/// 이 값은 store.ts 의 hasConfirmedNoGit 과 같은 기준(branch==="?")으로 재조회/fetch 대상에서도 제외됨.
/// cwd 가 비었는데도 `git -C ""` 를 실행하면 git 이 프로세스의 실제 작업 디렉터리를 대상으로 동작해버릴
/// 위험이 있어(엉뚱한 폴더에 명령이 나감) 아예 시도조차 안 하는 게 안전함.
pub fn compute_git_info(cwd: &str) -> GitInfo {
    if cwd.trim().is_empty() {
        return GitInfo { branch: "?".to_string(), ahead: 0, behind: 0, dirty: false };
    }
    let branch = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "?".into());
    let (ahead, behind) = run_git(cwd, &["rev-list", "--left-right", "--count", "HEAD...@{u}"])
        .map(|s| parse_ahead_behind(&s))
        .unwrap_or((0, 0));
    let dirty = run_git(cwd, &["status", "--porcelain"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    GitInfo { branch, ahead, behind, dirty }
}

// (async) 로 메인 스레드 밖에서 실행 — git 서브프로세스(네트워크 fetch 포함)가 UI 스레드를 막지 않게.
#[tauri::command(async)]
pub fn git_info(app: AppHandle, id: String) -> Result<GitInfo, String> {
    let cwd = cwd_for(&app, &id)?;
    Ok(compute_git_info(&cwd))
}

#[tauri::command(async)]
pub fn git_fetch(app: AppHandle, id: String) -> Result<GitInfo, String> {
    let cwd = cwd_for(&app, &id)?;
    // cwd 미설정이면 fetch 자체를 스킵(반복 에러 로그 방지) - compute_git_info 가 "?" 상태를 그대로 돌려줌.
    if !cwd.trim().is_empty() {
        if let Err(e) = run_git(&cwd, &["fetch", "--quiet"]) {
            sys_line(&app, &id, format!("git fetch failed: {e}"));
        }
    }
    let info = compute_git_info(&cwd);
    let _ = app.emit("git", serde_json::json!({ "id": id, "info": info }));
    Ok(info)
}

/// pull 출력(stdout+stderr 합본)에서 사용자가 로그에서 놓치기 쉬운 두 가지 위험 상태를 감지해
/// 강조 sys 줄을 만든다. rebase 충돌과 autostash 복원 충돌은 서로 다른 조치가 필요해(전자는 rebase
/// continue/abort, 후자는 stash pop) 둘 다 나타날 수 있으면 둘 다 보여준다.
pub fn detect_pull_warnings(output: &str) -> Vec<String> {
    let mut warnings = Vec::new();
    if output.contains("CONFLICT") || output.contains("could not apply") {
        warnings.push("⚠ rebase 충돌로 중단 — 터미널에서 git rebase --continue/--abort 필요".to_string());
    }
    if output.contains("Applying autostash resulted in conflicts") {
        warnings.push("⚠ autostash 복원 충돌 — 변경은 stash 에 보존됨, git stash pop 으로 복원".to_string());
    }
    warnings
}

/// 일반 설정의 pull_mode 로부터 실제 git 인자와 sys 헤더 줄을 만든다. "merge" 만 인자 없는 기본 pull,
/// 그 외(기본값 "rebase" 포함, 알 수 없는 값도 안전하게)는 전부 --rebase --autostash.
/// --rebase --autostash: 로컬 커밋을 remote 위로 재배치하고, 작업 중이던 변경은 pull 동안 자동으로
/// stash 했다가 끝나면 되돌려놓음 - merge 커밋이 안 생기고 dirty 상태에서도 pull 가능해짐.
pub fn pull_args_for_mode(pull_mode: &str) -> (Vec<&'static str>, &'static str) {
    if pull_mode == "merge" {
        (vec!["pull"], "── git pull ──")
    } else {
        (vec!["pull", "--rebase", "--autostash"], "── git pull --rebase --autostash ──")
    }
}

fn pull_mode_for(app: &AppHandle) -> String {
    app.state::<ConfigState>().0.lock().unwrap().pull_mode.clone()
}

// Pull All(store.ts pullAll)도 서비스별로 이 커맨드를 그대로 호출하므로 pull_mode 설정이 동일하게 적용됨.
#[tauri::command(async)]
pub fn git_pull(app: AppHandle, id: String) -> Result<GitInfo, String> {
    let cwd = cwd_for(&app, &id)?;
    // 프론트에서 이미 폴더 없는 서비스는 Git Pull 버튼을 막지만, 방어적으로 한 번 더 - cwd 가 비면
    // `git -C ""` 가 프로세스의 실제 작업 디렉터리를 대상으로 동작해버릴 위험이 있어 아예 막는다.
    if cwd.trim().is_empty() {
        return Err(format!("{id}: 폴더가 설정되지 않았습니다"));
    }
    let (args, header) = pull_args_for_mode(&pull_mode_for(&app));
    sys_line(&app, &id, header.to_string());

    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&cwd).args(&args);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    no_window(&mut cmd);
    let output = cmd.output().map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    for line in stdout.lines() {
        sys_line(&app, &id, line.to_string());
    }
    for line in stderr.lines() {
        sys_line(&app, &id, line.to_string());
    }

    // 사용자가 놓치기 쉬운 충돌 상태는 원본 출력 뒤에 강조 줄로 한 번 더 표시.
    for warning in detect_pull_warnings(&format!("{stdout}\n{stderr}")) {
        sys_line(&app, &id, warning);
    }

    let info = compute_git_info(&cwd);
    let _ = app.emit("git", serde_json::json!({ "id": id, "info": info }));
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ahead_behind_counts() {
        assert_eq!(parse_ahead_behind("2\t3\n"), (2, 3));
    }

    #[test]
    fn parses_zero_when_output_empty() {
        assert_eq!(parse_ahead_behind(""), (0, 0));
    }

    #[test]
    fn parses_zero_behind() {
        assert_eq!(parse_ahead_behind("5\t0\n"), (5, 0));
    }

    #[test]
    fn compute_git_info_skips_git_entirely_when_cwd_is_empty() {
        // 실제 git 커맨드를 한 번도 안 부르고(느리지 않아야 정상 - 실행되면 이 테스트도 느려짐) 바로
        // "정보 없음" 상태(branch="?")를 돌려줘야 함 - 빈 cwd 로 `git -C ""` 를 실제로 실행하면 위험함.
        let info = compute_git_info("");
        assert_eq!(info.branch, "?");
        assert_eq!(info.ahead, 0);
        assert_eq!(info.behind, 0);
        assert!(!info.dirty);
    }

    #[test]
    fn compute_git_info_skips_git_entirely_when_cwd_is_whitespace_only() {
        let info = compute_git_info("   ");
        assert_eq!(info.branch, "?");
    }

    #[test]
    fn no_warnings_on_clean_already_up_to_date() {
        assert!(detect_pull_warnings("Already up to date.").is_empty());
    }

    #[test]
    fn no_warnings_on_clean_rebase_with_autostash() {
        let output = "\
Created autostash: a1b2c3d
First, rewinding head to replay your work on top of it...
Applying: local commit message
Applied autostash.
";
        assert!(detect_pull_warnings(output).is_empty());
    }

    #[test]
    fn detects_rebase_conflict_via_conflict_marker() {
        let output = "\
Auto-merging src/foo.rs
CONFLICT (content): Merge conflict in src/foo.rs
error: could not apply 1a2b3c4... commit message
";
        let warnings = detect_pull_warnings(output);
        assert!(warnings.iter().any(|w| w.contains("rebase 충돌로 중단")));
    }

    #[test]
    fn detects_rebase_conflict_via_could_not_apply_without_conflict_word() {
        // 드물게 CONFLICT 단어 없이 could not apply 만 나오는 케이스도 감지해야 함.
        let output = "error: could not apply 1a2b3c4... commit message";
        let warnings = detect_pull_warnings(output);
        assert!(warnings.iter().any(|w| w.contains("rebase 충돌로 중단")));
    }

    #[test]
    fn detects_autostash_conflict() {
        let output = "\
Applying autostash resulted in conflicts.
Your changes are safe in the stash.
You can run \"git stash pop\" or \"git stash drop\" at any time.
";
        let warnings = detect_pull_warnings(output);
        assert!(warnings.iter().any(|w| w.contains("autostash 복원 충돌")));
        // autostash 충돌 메시지 자체엔 rebase 진행 실패를 뜻하는 CONFLICT/could not apply 가 없으므로
        // rebase 충돌 경고는 같이 뜨면 안 됨(오탐 방지).
        assert!(!warnings.iter().any(|w| w.contains("rebase 충돌로 중단")));
    }

    #[test]
    fn detects_both_when_rebase_and_autostash_both_conflict() {
        let output = "\
CONFLICT (content): Merge conflict in src/foo.rs
error: could not apply 1a2b3c4... commit message
Applying autostash resulted in conflicts.
Your changes are safe in the stash.
";
        let warnings = detect_pull_warnings(output);
        assert_eq!(warnings.len(), 2);
        assert!(warnings.iter().any(|w| w.contains("rebase 충돌로 중단")));
        assert!(warnings.iter().any(|w| w.contains("autostash 복원 충돌")));
    }

    #[test]
    fn pull_mode_merge_uses_plain_pull_with_no_extra_args() {
        let (args, header) = pull_args_for_mode("merge");
        assert_eq!(args, vec!["pull"]);
        assert_eq!(header, "── git pull ──");
    }

    #[test]
    fn pull_mode_rebase_uses_rebase_autostash_args() {
        let (args, header) = pull_args_for_mode("rebase");
        assert_eq!(args, vec!["pull", "--rebase", "--autostash"]);
        assert_eq!(header, "── git pull --rebase --autostash ──");
    }

    #[test]
    fn pull_mode_unknown_value_falls_back_to_rebase_autostash() {
        // config.json 을 손으로 잘못 고쳐도(예: 오타) 기존 동작(rebase)을 유지하는 게 안전한 기본값.
        let (args, _) = pull_args_for_mode("something-else");
        assert_eq!(args, vec!["pull", "--rebase", "--autostash"]);
    }
}
