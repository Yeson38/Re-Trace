#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// Result types shared with the frontend
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct RecordTiming {
    instrument_ms: u64,
    compile_ms: Option<u64>,
    run_ms: u64,
    total_ms: u64,
}

#[derive(serde::Serialize)]
struct RecordDiagnostic {
    severity: String,
    line: Option<u32>,
    column: Option<u32>,
    message: String,
    raw: Option<String>,
}

#[derive(serde::Serialize)]
struct RecordResultRust {
    ok: bool,
    id: String,
    timing: RecordTiming,
    total_phases: u8,
    trace_file_json: Option<String>,
    diagnostics: Vec<RecordDiagnostic>,
    summary: Option<String>,
}

#[derive(serde::Serialize)]
struct ToolchainEntry {
    available: bool,
    path: Option<String>,
    version: Option<String>,
}

#[derive(serde::Serialize)]
struct ToolchainInfo {
    python3: ToolchainEntry,
    gpp: ToolchainEntry,
}

// ---------------------------------------------------------------------------
// Subprocess runner: spawns with piped stdout/stderr, enforces a timeout,
// and drains both pipes on background threads so a chatty child cannot
// deadlock on a full pipe buffer.
// ---------------------------------------------------------------------------

struct ProcResult {
    timed_out: bool,
    exit_code: Option<i32>,
    #[allow(dead_code)]
    stdout: String,
    stderr: String,
}

fn run_with_timeout(mut cmd: Command, timeout_ms: u64) -> Result<ProcResult, String> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn process: {}", e))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout pipe not available".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "stderr pipe not available".to_string())?;

    let out_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });

    let start = Instant::now();
    let mut timed_out = false;
    let mut exit_code: Option<i32> = None;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code();
                break;
            }
            Ok(None) => {
                if timeout_ms > 0 && start.elapsed().as_millis() as u64 >= timeout_ms {
                    let _ = child.kill();
                    if let Ok(s) = child.wait() {
                        exit_code = s.code();
                    }
                    timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(format!("failed to wait on child process: {}", e)),
        }
    }

    let stdout_bytes = out_thread
        .join()
        .map_err(|_| "stdout reader thread panicked".to_string())?;
    let stderr_bytes = err_thread
        .join()
        .map_err(|_| "stderr reader thread panicked".to_string())?;

    Ok(ProcResult {
        timed_out,
        exit_code,
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
    })
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Build a unique temp-file base name. Honours a caller-provided name, but
/// always ensures it carries the `retrace_` prefix so files land inside the
/// declared `fs:scope` (`/tmp/retrace_*`, `$TEMP/retrace_*`).
fn ensure_temp_base(temp_file_name: &str) -> String {
    let name = temp_file_name.trim();
    if name.is_empty() {
        format!("retrace_{}", timestamp_ms())
    } else if name.starts_with("retrace_") {
        name.to_string()
    } else {
        format!("retrace_{}", name)
    }
}

fn write_temp_file(tmp: &Path, base: &str, ext: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let mut p = tmp.to_path_buf();
    p.push(format!("{}.{}", base, ext));
    let mut f =
        fs::File::create(&p).map_err(|e| format!("failed to create {}: {}", p.display(), e))?;
    f.write_all(bytes)
        .map_err(|e| format!("failed to write {}: {}", p.display(), e))?;
    Ok(p)
}

fn json_result(r: RecordResultRust) -> String {
    serde_json::to_string(&r).unwrap_or_else(|_| "{}".to_string())
}

fn make_summary(trace_json: &str, language: &str) -> Option<String> {
    match serde_json::from_str::<serde_json::Value>(trace_json) {
        Ok(v) => {
            let n = v
                .get("steps")
                .and_then(|s| s.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            Some(format!("Recorded {} {} steps", n, language))
        }
        Err(_) => Some("Recorded trace".to_string()),
    }
}

fn first_line(s: &str) -> String {
    s.lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .to_string()
}

// ---------------------------------------------------------------------------
// Toolchain probe
// ---------------------------------------------------------------------------

fn which_path(cmd: &str) -> Option<String> {
    let out = Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {}", cmd))
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn run_version(cmd: &str) -> Option<String> {
    let out = Command::new(cmd).arg("--version").output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let e = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let v = if s.is_empty() { e } else { s };
    let first = v.lines().next().unwrap_or("").to_string();
    if first.is_empty() {
        None
    } else {
        Some(first)
    }
}

fn probe_toolchain(cmd: &str) -> ToolchainEntry {
    let version = run_version(cmd);
    ToolchainEntry {
        available: version.is_some(),
        path: which_path(cmd),
        version,
    }
}

#[tauri::command]
fn native_check_toolchains() -> Result<String, String> {
    let info = ToolchainInfo {
        python3: probe_toolchain("python3"),
        gpp: probe_toolchain("g++"),
    };
    serde_json::to_string(&info).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// g++ stderr diagnostic parsing
//
// Recognised forms (column optional):
//   <file>:<line>:<col>: <severity>: <message>
//   <file>:<line>: <severity>: <message>
// `fatal error` is folded into `error`; `note` lines are ignored so only
// actionable errors/warnings reach the frontend.
// ---------------------------------------------------------------------------

fn parse_gcc_line(line: &str) -> Option<RecordDiagnostic> {
    let markers = [("fatal error", "error"), ("error", "error"), ("warning", "warning")];
    for (raw, norm) in markers {
        let needle = format!(": {}: ", raw);
        if let Some(pos) = line.find(&needle) {
            let prefix = &line[..pos];
            let msg_start = pos + needle.len();
            let message = line[msg_start..].to_string();
            let (line_no, col) = parse_loc(prefix);
            return Some(RecordDiagnostic {
                severity: norm.to_string(),
                line: line_no,
                column: col,
                message,
                raw: Some(line.to_string()),
            });
        }
    }
    None
}

fn parse_loc(prefix: &str) -> (Option<u32>, Option<u32>) {
    let parts: Vec<&str> = prefix.rsplitn(3, ':').collect();
    match parts.len() {
        2 => (parts[0].parse::<u32>().ok(), None),
        3 => {
            let col = parts[0].parse::<u32>().ok();
            let line_no = parts[1].parse::<u32>().ok();
            (line_no, col)
        }
        _ => (None, None),
    }
}

fn parse_gcc_diagnostics(stderr: &str) -> Vec<RecordDiagnostic> {
    stderr.lines().filter_map(parse_gcc_line).collect()
}

// ---------------------------------------------------------------------------
// Trace.json discovery for the C++ binary, which writes its trace file into
// the working directory we run it from (path is hard-coded by the user's
// `__RT_MAIN(...)`). We scan that directory for a JSON file carrying a
// `steps` array, preferring `trace.json` then `*.trace.json`, then the
// most-recently modified `.json`.
// ---------------------------------------------------------------------------

fn trace_score(name: &str) -> u8 {
    if name == "trace.json" {
        2
    } else if name.ends_with(".trace.json") {
        1
    } else {
        0
    }
}

fn file_mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).and_then(|m| m.modified()).ok()
}

fn find_trace_json(dir: &Path) -> Option<String> {
    let mut entries: Vec<PathBuf> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("json") {
                entries.push(p);
            }
        }
    }
    entries.sort_by(|a, b| {
        let sa = trace_score(a.file_name().and_then(|f| f.to_str()).unwrap_or(""));
        let sb = trace_score(b.file_name().and_then(|f| f.to_str()).unwrap_or(""));
        sb.cmp(&sa).then_with(|| file_mtime(b).cmp(&file_mtime(a)))
    });
    for p in entries {
        if let Ok(content) = fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                if v.get("steps").is_some() {
                    return Some(content);
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// python_record
//
// Writes the user's source to a temp file, runs `python3 instrument.py`
// with the unified Python adapter (which instruments and executes in one
// pass, writing trace.json), then reads the trace back as a JSON string.
// ---------------------------------------------------------------------------

#[tauri::command]
fn python_record(
    source: String,
    adapter_script_path: String,
    max_steps: u32,
    timeout_ms: u64,
    temp_file_name: String,
) -> Result<String, String> {
    let id = ensure_temp_base(&temp_file_name);
    let tmp = std::env::temp_dir();

    let src_path = write_temp_file(&tmp, &id, "py", source.as_bytes())?;

    let mut trace_path = tmp.clone();
    trace_path.push(format!("{}.trace.json", id));

    let t0 = Instant::now();
    let mut cmd = Command::new("python3");
    cmd.arg(&adapter_script_path)
        .arg(&src_path)
        .arg("-o")
        .arg(&trace_path)
        .arg("--max-steps")
        .arg(max_steps.to_string());
    let proc = run_with_timeout(cmd, timeout_ms)?;
    let run_ms = t0.elapsed().as_millis() as u64;
    let timing = RecordTiming {
        instrument_ms: 0,
        compile_ms: None,
        run_ms,
        total_ms: run_ms,
    };

    if proc.timed_out {
        return Ok(json_result(RecordResultRust {
            ok: false,
            id: id.clone(),
            timing,
            total_phases: 2,
            trace_file_json: None,
            diagnostics: vec![RecordDiagnostic {
                severity: "error".into(),
                line: None,
                column: None,
                message: format!("python3 instrument exceeded {} ms timeout", timeout_ms),
                raw: None,
            }],
            summary: Some("Recording timed out".into()),
        }));
    }

    match fs::read_to_string(&trace_path) {
        Ok(json) => {
            let summary = make_summary(&json, "python");
            Ok(json_result(RecordResultRust {
                ok: true,
                id: id.clone(),
                timing,
                total_phases: 2,
                trace_file_json: Some(json),
                diagnostics: Vec::new(),
                summary,
            }))
        }
        Err(_) => {
            let raw = if proc.stderr.trim().is_empty() {
                None
            } else {
                Some(proc.stderr.clone())
            };
            let message = if proc.stderr.trim().is_empty() {
                "python3 instrument failed to produce trace.json".to_string()
            } else {
                first_line(&proc.stderr)
            };
            Ok(json_result(RecordResultRust {
                ok: false,
                id: id.clone(),
                timing,
                total_phases: 2,
                trace_file_json: None,
                diagnostics: vec![RecordDiagnostic {
                    severity: "error".into(),
                    line: None,
                    column: None,
                    message,
                    raw,
                }],
                summary: Some("Python recording failed".into()),
            }))
        }
    }
}

// ---------------------------------------------------------------------------
// cpp_record
//
// Three-phase pipeline mirroring the Pyodide/web flow but on the host:
//   1. instrument  -> `python3 instrument.py <src.cpp> -o <inst.cpp>`
//   2. compile     -> `g++ -std=c++17 -pthread -I<header_dir> <inst.cpp> -o <bin>`
//   3. run         -> execute <bin> in a temp workdir; it writes trace.json
//                     via retrace.h's atexit flush, which we then read back.
// ---------------------------------------------------------------------------

#[tauri::command]
fn cpp_record(
    source: String,
    adapter_script_path: String,
    retrace_header_path: String,
    max_steps: u32,
    timeout_ms: u64,
    temp_file_name: String,
) -> Result<String, String> {
    // The C++ runtime (retrace.h) currently has no per-step cap; max_steps
    // is honoured by the Python adapter only. Keep the binding present for
    // API symmetry with python_record and a future C++ cap.
    let _ = max_steps;

    let id = ensure_temp_base(&temp_file_name);
    let tmp = std::env::temp_dir();

    let src_path = write_temp_file(&tmp, &id, "cpp", source.as_bytes())?;

    let mut inst_path = tmp.clone();
    inst_path.push(format!("{}_inst.cpp", id));

    let mut bin_path = tmp.clone();
    bin_path.push(format!("{}_bin{}", id, std::env::consts::EXE_SUFFIX));

    let mut workdir = tmp.clone();
    workdir.push(format!("{}_work", id));
    fs::create_dir_all(&workdir)
        .map_err(|e| format!("failed to create workdir {}: {}", workdir.display(), e))?;

    let header_dir = Path::new(&retrace_header_path)
        .parent()
        .ok_or_else(|| "invalid retrace header path".to_string())?
        .to_path_buf();

    // Phase 1: instrument -------------------------------------------------
    let t0 = Instant::now();
    let mut cmd = Command::new("python3");
    cmd.arg(&adapter_script_path)
        .arg(&src_path)
        .arg("-o")
        .arg(&inst_path);
    let proc = run_with_timeout(cmd, timeout_ms)?;
    let instrument_ms = t0.elapsed().as_millis() as u64;

    if proc.timed_out {
        return Ok(json_result(RecordResultRust {
            ok: false,
            id: id.clone(),
            timing: RecordTiming {
                instrument_ms,
                compile_ms: None,
                run_ms: 0,
                total_ms: instrument_ms,
            },
            total_phases: 3,
            trace_file_json: None,
            diagnostics: vec![RecordDiagnostic {
                severity: "error".into(),
                line: None,
                column: None,
                message: format!("instrumentation exceeded {} ms timeout", timeout_ms),
                raw: None,
            }],
            summary: Some("Instrumentation timed out".into()),
        }));
    }

    if !inst_path.exists() {
        let raw = if proc.stderr.trim().is_empty() {
            None
        } else {
            Some(proc.stderr.clone())
        };
        let message = if proc.stderr.trim().is_empty() {
            "C++ instrumentation produced no output".to_string()
        } else {
            first_line(&proc.stderr)
        };
        return Ok(json_result(RecordResultRust {
            ok: false,
            id: id.clone(),
            timing: RecordTiming {
                instrument_ms,
                compile_ms: None,
                run_ms: 0,
                total_ms: instrument_ms,
            },
            total_phases: 3,
            trace_file_json: None,
            diagnostics: vec![RecordDiagnostic {
                severity: "error".into(),
                line: None,
                column: None,
                message,
                raw,
            }],
            summary: Some("Instrumentation failed".into()),
        }));
    }

    // Phase 2: compile ----------------------------------------------------
    let t1 = Instant::now();
    let mut cmd = Command::new("g++");
    cmd.arg("-std=c++17")
        .arg("-pthread")
        .arg("-O0")
        .arg("-g")
        .arg("-I")
        .arg(&header_dir)
        .arg(&inst_path)
        .arg("-o")
        .arg(&bin_path);
    let proc = run_with_timeout(cmd, timeout_ms)?;
    let compile_ms = t1.elapsed().as_millis() as u64;

    if proc.timed_out {
        return Ok(json_result(RecordResultRust {
            ok: false,
            id: id.clone(),
            timing: RecordTiming {
                instrument_ms,
                compile_ms: Some(compile_ms),
                run_ms: 0,
                total_ms: instrument_ms + compile_ms,
            },
            total_phases: 3,
            trace_file_json: None,
            diagnostics: vec![RecordDiagnostic {
                severity: "error".into(),
                line: None,
                column: None,
                message: format!("g++ exceeded {} ms timeout", timeout_ms),
                raw: None,
            }],
            summary: Some("Compilation timed out".into()),
        }));
    }

    let compile_ok = proc.exit_code == Some(0) && bin_path.exists();
    if !compile_ok {
        let mut diags = parse_gcc_diagnostics(&proc.stderr);
        if diags.is_empty() {
            let message = if proc.stderr.trim().is_empty() {
                "C++ compilation failed".to_string()
            } else {
                first_line(&proc.stderr)
            };
            diags.push(RecordDiagnostic {
                severity: "error".into(),
                line: None,
                column: None,
                message,
                raw: Some(proc.stderr.clone()),
            });
        }
        let count = diags.len();
        return Ok(json_result(RecordResultRust {
            ok: false,
            id: id.clone(),
            timing: RecordTiming {
                instrument_ms,
                compile_ms: Some(compile_ms),
                run_ms: 0,
                total_ms: instrument_ms + compile_ms,
            },
            total_phases: 3,
            trace_file_json: None,
            diagnostics: diags,
            summary: Some(format!("Compilation failed ({} diagnostic(s))", count)),
        }));
    }

    // Phase 3: run --------------------------------------------------------
    let t2 = Instant::now();
    let mut cmd = Command::new(&bin_path);
    cmd.current_dir(&workdir);
    let proc = run_with_timeout(cmd, timeout_ms)?;
    let run_ms = t2.elapsed().as_millis() as u64;
    let total = instrument_ms + compile_ms + run_ms;
    let timing = RecordTiming {
        instrument_ms,
        compile_ms: Some(compile_ms),
        run_ms,
        total_ms: total,
    };

    if proc.timed_out {
        return Ok(json_result(RecordResultRust {
            ok: false,
            id: id.clone(),
            timing,
            total_phases: 3,
            trace_file_json: None,
            diagnostics: vec![RecordDiagnostic {
                severity: "error".into(),
                line: None,
                column: None,
                message: format!("program exceeded {} ms timeout", timeout_ms),
                raw: Some(proc.stderr.clone()),
            }],
            summary: Some("Program timed out".into()),
        }));
    }

    match find_trace_json(&workdir) {
        Some(content) => {
            let summary = make_summary(&content, "cpp");
            let mut diags = Vec::new();
            if proc.exit_code != Some(0) {
                let code_repr = match proc.exit_code {
                    Some(c) => format!("code {}", c),
                    None => "signal termination".to_string(),
                };
                diags.push(RecordDiagnostic {
                    severity: "warning".into(),
                    line: None,
                    column: None,
                    message: format!("program exited abnormally ({})", code_repr),
                    raw: None,
                });
            }
            if !proc.stderr.trim().is_empty() {
                diags.push(RecordDiagnostic {
                    severity: "warning".into(),
                    line: None,
                    column: None,
                    message: first_line(&proc.stderr),
                    raw: Some(proc.stderr.clone()),
                });
            }
            Ok(json_result(RecordResultRust {
                ok: true,
                id: id.clone(),
                timing,
                total_phases: 3,
                trace_file_json: Some(content),
                diagnostics: diags,
                summary,
            }))
        }
        None => {
            let raw = if proc.stderr.trim().is_empty() {
                None
            } else {
                Some(proc.stderr.clone())
            };
            let message = if proc.stderr.trim().is_empty() {
                "program did not produce a trace.json".to_string()
            } else {
                first_line(&proc.stderr)
            };
            Ok(json_result(RecordResultRust {
                ok: false,
                id: id.clone(),
                timing,
                total_phases: 3,
                trace_file_json: None,
                diagnostics: vec![RecordDiagnostic {
                    severity: "error".into(),
                    line: None,
                    column: None,
                    message,
                    raw,
                }],
                summary: Some("No trace produced".into()),
            }))
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            native_check_toolchains,
            python_record,
            cpp_record
        ])
        .run(tauri::generate_context!())
        .expect("error while running Re-Trace application");
}
