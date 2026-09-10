// Docker / Rancher Desktop (nerdctl) container discovery for the Terminal panel's log sources.
//
// This module only DISCOVERS containers; it does not stream anything. The log stream is still a
// shell command typed into the PTY that `local.rs`/`ssh.rs` own, so nothing here speaks the message
// protocol documented at the top of `terminal/mod.rs`.
//
// Everything here shells out, and a process spawn blocks. Both commands therefore run their body on
// `spawn_blocking`: a command taking no `State` is `'static`, so Tauri spawns it onto the async
// runtime, and blocking there stalls a runtime worker thread.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerCliInfo {
    pub available: bool,
    pub cli_type: String, // "docker" | "nerdctl" | "none"
    pub binary_path: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub ports: String,
    pub status: String,
    /// The container is up. `docker ps -a` lists stopped ones too — a stopped database container is
    /// exactly what someone whose connection just failed needs to see, and its logs are still
    /// readable — but a stopped container publishes no ports, so it can never match one.
    pub running: bool,
    /// The published HOST port matches the port the connection uses.
    pub matched_host_port: bool,
    /// Only the container's INTERNAL port matches — same image, different published port, so it is
    /// a weaker signal and ranks below a host-port match.
    pub matched_container_port: bool,
}

/// A CLI that has been found and proved to run.
#[derive(Debug, Clone)]
struct DockerCli {
    cli_type: String,
    binary_path: String,
    version: String,
}

/// Caches the POSITIVE result only.
///
/// Probing means executing `--version` on up to nine candidate paths, and both commands need the
/// answer — `list_docker_containers` on every refresh, which the panel calls each time the log menu
/// opens. A negative result is deliberately not cached: somebody who starts Docker Desktop while the
/// app is open should be found on the next scan, and the failing candidates are missing paths, which
/// fail before a process is created.
static CLI_CACHE: Mutex<Option<DockerCli>> = Mutex::new(None);

/// Builds a `Command` that opens no console window on Windows.
fn silent_command(program: &str) -> Command {
    // The binding is only mutated by the Windows block below, so every other target sees an
    // `unused_mut` here. Gated rather than blanket-allowed: on Windows the lint still applies.
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// The candidate binaries to probe, in preference order: PATH first, then the known install roots.
fn cli_candidates() -> Vec<(&'static str, PathBuf)> {
    let mut candidates: Vec<(&'static str, PathBuf)> = Vec::new();

    #[cfg(windows)]
    {
        candidates.push(("docker", PathBuf::from("docker.exe")));
        candidates.push(("nerdctl", PathBuf::from("nerdctl.exe")));

        // Rancher Desktop's shim directory.
        if let Ok(userprofile) = std::env::var("USERPROFILE") {
            let rd_bin = Path::new(&userprofile).join(".rd").join("bin");
            candidates.push(("docker", rd_bin.join("docker.exe")));
            candidates.push(("nerdctl", rd_bin.join("nerdctl.exe")));
        }

        candidates.push((
            "docker",
            PathBuf::from(r"C:\Program Files\Docker\Docker\resources\bin\docker.exe"),
        ));

        // Rancher Desktop's bundled copies.
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            let rd_app = Path::new(&localappdata)
                .join("Programs")
                .join("Rancher Desktop")
                .join("resources")
                .join("resources")
                .join("win32")
                .join("bin");
            candidates.push(("nerdctl", rd_app.join("nerdctl.exe")));
            candidates.push(("docker", rd_app.join("docker.exe")));
        }
    }

    #[cfg(not(windows))]
    {
        candidates.push(("docker", PathBuf::from("docker")));
        candidates.push(("nerdctl", PathBuf::from("nerdctl")));

        // Homebrew, Apple Silicon then Intel.
        candidates.push(("docker", PathBuf::from("/opt/homebrew/bin/docker")));
        candidates.push(("nerdctl", PathBuf::from("/opt/homebrew/bin/nerdctl")));
        candidates.push(("docker", PathBuf::from("/usr/local/bin/docker")));
        candidates.push(("nerdctl", PathBuf::from("/usr/local/bin/nerdctl")));

        if let Ok(home) = std::env::var("HOME") {
            let rd_bin = Path::new(&home).join(".rd").join("bin");
            candidates.push(("docker", rd_bin.join("docker")));
            candidates.push(("nerdctl", rd_bin.join("nerdctl")));
        }
    }

    candidates
}

/// Finds a CLI that runs, returning what `--version` printed so no second process is needed.
///
/// BLOCKING — call it from `spawn_blocking`.
fn find_docker_cli() -> Option<DockerCli> {
    if let Ok(cache) = CLI_CACHE.lock()
        && let Some(found) = cache.as_ref()
    {
        return Some(found.clone());
    }

    for (cli_type, path) in cli_candidates() {
        let path_str = path.to_string_lossy().to_string();
        let Ok(output) = silent_command(&path_str).arg("--version").output() else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let found = DockerCli {
            cli_type: cli_type.to_string(),
            binary_path: path_str,
            version: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        };
        if let Ok(mut cache) = CLI_CACHE.lock() {
            *cache = Some(found.clone());
        }
        return Some(found);
    }

    None
}

/// Runs a blocking closure off the async runtime, framing a panic in the closure as a real error
/// rather than letting a `JoinError`'s English text escape untranslated.
async fn blocking<T, F>(label: &str, work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(e) => Err(format!("Không chạy được {}: {}", label, e)),
    }
}

#[command]
pub async fn get_docker_cli_info() -> Result<DockerCliInfo, String> {
    Box::pin(async move {
        blocking("docker", || {
            Ok(match find_docker_cli() {
                Some(cli) => DockerCliInfo {
                    available: true,
                    cli_type: cli.cli_type,
                    binary_path: cli.binary_path,
                    version: cli.version,
                },
                None => DockerCliInfo {
                    available: false,
                    cli_type: "none".to_string(),
                    binary_path: String::new(),
                    version: String::new(),
                },
            })
        })
        .await
    })
    .await
}

/// The fields asked of `ps`, in the order `parse_ps_line` reads them.
const PS_FORMAT: &str = "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}";

/// One line of `ps --format PS_FORMAT` -> a container, or `None` for a line too short to trust.
///
/// Pure, so the port matching below is testable without a Docker install.
fn parse_ps_line(line: &str, target_port: Option<u16>) -> Option<DockerContainerInfo> {
    // Only the line ENDING is stripped. `str::trim` would also eat a trailing EMPTY FIELD, and a
    // stopped container publishes no ports — so a line whose last fields are empty would split into
    // fewer parts than expected and the container would be dropped with no trace. Individual fields
    // are still trimmed below.
    let line = line.trim_end_matches(['\r', '\n']);
    if line.trim().is_empty() {
        return None;
    }

    let parts: Vec<&str> = line.split('\t').collect();
    if parts.len() < 4 {
        return None;
    }

    let ports = parts[3].trim().to_string();
    let status = parts.get(4).map(|s| s.trim()).unwrap_or("").to_string();

    // `{{.Status}}` reads "Up 3 hours" / "Exited (0) 2 minutes ago" / "Created".
    let running = status.starts_with("Up");

    // `{{.Ports}}` reads "0.0.0.0:3307->3306/tcp". Both halves are looked for, and they are kept
    // apart rather than OR-ed: `:3307->` says the connection's port IS this container's published
    // port, while `->3306/` only says the image listens on that port internally, which every other
    // container of the same image also does. The delimiters matter — searching for `3307` alone
    // would match `:13307->`.
    let matched_host_port = target_port.is_some_and(|p| ports.contains(&format!(":{}->", p)));
    let matched_container_port = target_port.is_some_and(|p| ports.contains(&format!("->{}/", p)));

    Some(DockerContainerInfo {
        id: parts[0].trim().to_string(),
        name: parts[1].trim().to_string(),
        image: parts[2].trim().to_string(),
        ports,
        status,
        running,
        matched_host_port,
        matched_container_port,
    })
}

#[command]
pub async fn list_docker_containers(
    target_port: Option<u16>,
) -> Result<Vec<DockerContainerInfo>, String> {
    Box::pin(async move {
        blocking("docker ps", move || {
            let cli =
                find_docker_cli().ok_or("Không tìm thấy lệnh docker hoặc nerdctl trên máy")?;

            let output = silent_command(&cli.binary_path)
                .arg("ps")
                .arg("-a")
                .arg("--format")
                .arg(PS_FORMAT)
                .output()
                .map_err(|e| format!("Không chạy được {}: {}", cli.cli_type, e))?;

            if !output.status.success() {
                let err = String::from_utf8_lossy(&output.stderr);
                return Err(format!(
                    "Không liệt kê được container ({}): {}",
                    cli.cli_type,
                    err.trim()
                ));
            }

            let stdout = String::from_utf8_lossy(&output.stdout);
            let mut containers: Vec<DockerContainerInfo> = stdout
                .lines()
                .filter_map(|line| parse_ps_line(line, target_port))
                .collect();

            // Best guess first: the container publishing the port being connected to, then one that
            // merely listens on it, then anything still up, then by name for a stable order.
            containers.sort_by(|a, b| {
                b.matched_host_port
                    .cmp(&a.matched_host_port)
                    .then_with(|| b.matched_container_port.cmp(&a.matched_container_port))
                    .then_with(|| b.running.cmp(&a.running))
                    .then_with(|| a.name.cmp(&b.name))
            });

            Ok(containers)
        })
        .await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE: &str = "abc123\tmy-mysql\tmysql:8\t0.0.0.0:3307->3306/tcp\tUp 3 hours";

    #[test]
    fn reads_every_field() {
        let c = parse_ps_line(LINE, None).unwrap();
        assert_eq!(c.id, "abc123");
        assert_eq!(c.name, "my-mysql");
        assert_eq!(c.image, "mysql:8");
        assert_eq!(c.ports, "0.0.0.0:3307->3306/tcp");
        assert!(c.running);
    }

    #[test]
    fn separates_a_host_port_match_from_a_container_port_match() {
        let host = parse_ps_line(LINE, Some(3307)).unwrap();
        assert!(host.matched_host_port);
        assert!(!host.matched_container_port);

        let inner = parse_ps_line(LINE, Some(3306)).unwrap();
        assert!(!inner.matched_host_port);
        assert!(inner.matched_container_port);
    }

    #[test]
    fn a_longer_port_does_not_match_a_prefix_of_it() {
        let line = "id\tn\ti\t0.0.0.0:13307->13306/tcp\tUp 1 second";
        let c = parse_ps_line(line, Some(3307)).unwrap();
        assert!(!c.matched_host_port);
        assert!(!c.matched_container_port);
    }

    #[test]
    fn a_stopped_container_is_listed_and_marked() {
        let line = "id\tpg\tpostgres:16\t\tExited (0) 2 minutes ago";
        let c = parse_ps_line(line, Some(5432)).unwrap();
        assert!(!c.running);
        // No published ports while stopped, so it can never match one.
        assert!(!c.matched_host_port);
        assert!(!c.matched_container_port);
    }

    #[test]
    fn keeps_a_trailing_empty_field() {
        // Trimming the whole line ate this one and dropped the container without a trace.
        let bare = parse_ps_line("id\tn\ti\t", None).unwrap();
        assert_eq!(bare.ports, "");
        assert_eq!(bare.status, "");
    }

    #[test]
    fn a_crlf_ending_does_not_become_part_of_the_last_field() {
        let c = parse_ps_line("id\tn\ti\tp\tUp 2 days\r\n", None).unwrap();
        assert_eq!(c.status, "Up 2 days");
        assert!(c.running);
    }

    #[test]
    fn skips_a_line_too_short_to_trust() {
        assert!(parse_ps_line("id\tn\ti", None).is_none());
        assert!(parse_ps_line("   ", None).is_none());
    }
}
