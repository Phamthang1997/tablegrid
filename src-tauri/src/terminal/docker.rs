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
    /// The pod's sandbox ("pause") container. Kept on the struct rather than dropped in the parser
    /// so the decision stays testable and the caller decides what to do with it.
    pub is_sandbox: bool,
    /// The container's own name inside the pod, when the name is one cri-dockerd built. "" otherwise.
    pub k8s_container: String,
    pub k8s_pod: String,
    pub k8s_namespace: String,
    /// The name says what the connection is: a `mysql` container for a MySQL connection. This is
    /// the evidence that REPLACES the port match under Kubernetes, where there is none to find.
    pub matched_name: bool,
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
            // Docker Desktop's own bin directory. Linking the CLI into /usr/local/bin is an
            // OPTIONAL step there (it needs a privileged helper, and plenty of people decline it),
            // so on a Mac this is routinely the only copy that exists -- the same gap the Rancher
            // Desktop entries close on Windows.
            let docker_bin = Path::new(&home).join(".docker").join("bin");
            candidates.push(("docker", docker_bin.join("docker")));

            let rd_bin = Path::new(&home).join(".rd").join("bin");
            candidates.push(("docker", rd_bin.join("docker")));
            candidates.push(("nerdctl", rd_bin.join("nerdctl")));
        }

        // The copy inside the .app bundle, the macOS twin of the Program Files path above. Last,
        // because it is the fallback for a Docker Desktop that was never linked anywhere.
        #[cfg(target_os = "macos")]
        candidates.push((
            "docker",
            PathBuf::from("/Applications/Docker.app/Contents/Resources/bin/docker"),
        ));
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

/// How many containers `probe_log_path` will spend a process spawn on.
///
/// The list arrives ranked, so the server is the first entry whenever a port matched; the cap is
/// there for the case where nothing matched and every container would otherwise be probed.
const MAX_PROBED_CONTAINERS: usize = 4;

/// The repository's last path segment, without registry, tag or digest.
///
/// `localhost:5000/rancher/mirrored-pause:3.6` -> `mirrored-pause`. The tag is stripped from the
/// SEGMENT rather than from the whole string, because a registry host carries a colon of its own.
fn image_repo_leaf(image: &str) -> &str {
    let no_digest = image.split('@').next().unwrap_or(image);
    let leaf = no_digest.rsplit('/').next().unwrap_or(no_digest);
    leaf.split(':').next().unwrap_or(leaf)
}

/// Is this a pod's sandbox ("pause") container?
///
/// Decided by IMAGE, not by name, and that is the whole point: the `k8s_POD_<pod>_…` naming is
/// dockershim/cri-dockerd's invention for squeezing pod metadata into docker's flat namespace, so
/// it does not exist under containerd -- which is what k3s and Rancher Desktop run by DEFAULT.
/// Every distribution's sandbox image is called `pause` (`registry.k8s.io/pause`,
/// `rancher/mirrored-pause`, `mcr.microsoft.com/oss/kubernetes/pause`), so the image answers the
/// question on every engine and every k8s version.
///
/// It matters because a pause container is a single static binary holding the pod's network
/// namespace open: no shell, no coreutils. Every action this panel offers -- tail, list, exec a
/// shell, even the `test -e` probe -- fails inside it with `executable file not found in $PATH`.
fn is_pause_image(image: &str) -> bool {
    matches!(image_repo_leaf(image), "pause" | "mirrored-pause")
}

/// Splits a cri-dockerd container name into (container, pod, namespace).
///
/// The format is `k8s_<container>_<pod>_<namespace>_<pod-uid>_<restart-count>` -- exactly six
/// fields, because none of the first four may contain `_` (Kubernetes names are RFC 1123 labels,
/// which allow only `-`) and a pod UID is a UUID. The sandbox spells its container field `POD`,
/// which no real container can be called: RFC 1123 requires lower case.
///
/// Used for DISPLAY and RANKING, never for deciding what to hide -- see `is_pause_image`.
fn parse_k8s_name(name: &str) -> Option<(String, String, String)> {
    let parts: Vec<&str> = name.split('_').collect();
    if parts.len() != 6 || parts[0] != "k8s" {
        return None;
    }
    Some((
        parts[1].to_string(),
        parts[2].to_string(),
        parts[3].to_string(),
    ))
}

/// Does this container's name say it is the thing the connection is talking to?
///
/// `hint` is the dialect ("mysql" / "postgres" / "redis"). Under Kubernetes this is the ONLY
/// evidence left: a Service's NodePort is handled by kube-proxy's iptables rules rather than a
/// docker port publish, so `{{.Ports}}` is empty for every container on the node and both port
/// matches are dead. The k8s container name is checked first because it is the exact field
/// ("mysql"), falling back to a substring of the whole name for ordinary docker.
fn name_matches_hint(name: &str, k8s_container: &str, hint: Option<&str>) -> bool {
    let Some(hint) = hint.filter(|h| !h.is_empty()) else {
        return false;
    };
    let hint = hint.to_ascii_lowercase();
    if !k8s_container.is_empty() {
        return k8s_container.to_ascii_lowercase().contains(&hint);
    }
    name.to_ascii_lowercase().contains(&hint)
}

/// One line of `ps --format PS_FORMAT` -> a container, or `None` for a line too short to trust.
///
/// Pure, so the port matching below is testable without a Docker install.
fn parse_ps_line(
    line: &str,
    target_port: Option<u16>,
    name_hint: Option<&str>,
) -> Option<DockerContainerInfo> {
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

    let name = parts[1].trim().to_string();
    let image = parts[2].trim().to_string();
    let (k8s_container, k8s_pod, k8s_namespace) = parse_k8s_name(&name).unwrap_or_default();
    let matched_name = name_matches_hint(&name, &k8s_container, name_hint);

    Some(DockerContainerInfo {
        id: parts[0].trim().to_string(),
        is_sandbox: is_pause_image(&image),
        name,
        image,
        ports,
        status,
        running,
        matched_host_port,
        matched_container_port,
        k8s_container,
        k8s_pod,
        k8s_namespace,
        matched_name,
    })
}

/// One `ps -a` run, optionally inside a containerd namespace.
///
/// BLOCKING -- call it from `spawn_blocking`.
fn ps_in_namespace(
    cli: &DockerCli,
    namespace: Option<&str>,
    target_port: Option<u16>,
    name_hint: Option<&str>,
) -> Result<Vec<DockerContainerInfo>, String> {
    let mut cmd = silent_command(&cli.binary_path);
    // `--namespace` is global and must precede the subcommand, which is why it is pushed first.
    if let Some(ns) = namespace {
        cmd.arg("--namespace").arg(ns);
    }
    let output = cmd
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
    Ok(stdout
        .lines()
        .filter_map(|line| parse_ps_line(line, target_port, name_hint))
        .collect())
}

/// Can anything be executed inside this container at all?
///
/// Asked BEFORE a tail or a shell is typed into the terminal, because the failure otherwise reads
/// `OCI runtime exec failed: exec: "tail": executable file not found in $PATH` -- which names the
/// wrong thing entirely. The path is fine; the container simply has no userland. That is true of
/// every pod sandbox and of every distroless or `scratch` image, which are ordinary in Kubernetes.
///
/// `test -e /` is the smallest question that needs a real binary to answer, and the answer arrives
/// as an exit status, so nothing has to be parsed and no localized error text can be misread.
#[command]
pub async fn container_has_shell(container: String) -> Result<bool, String> {
    Box::pin(async move {
        blocking("docker exec", move || {
            let Some(cli) = find_docker_cli() else {
                // No CLI is not an answer about the container, and reporting `false` would put the
                // blame on it. The caller already handles a missing CLI of its own.
                return Ok(true);
            };
            Ok(silent_command(&cli.binary_path)
                .arg("exec")
                .arg(&container)
                .arg("test")
                .arg("-e")
                .arg("/")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false))
        })
        .await
    })
    .await
}

#[command]
pub async fn list_docker_containers(
    target_port: Option<u16>,
    name_hint: Option<String>,
) -> Result<Vec<DockerContainerInfo>, String> {
    Box::pin(async move {
        blocking("docker ps", move || {
            let cli =
                find_docker_cli().ok_or("Không tìm thấy lệnh docker hoặc nerdctl trên máy")?;

            let hint = name_hint.as_deref();
            let mut containers = ps_in_namespace(&cli, None, target_port, hint)?;

            // nerdctl means containerd, and containerd keeps Kubernetes workloads in a namespace of
            // its own -- `k8s.io` -- while nerdctl defaults to `default`. So on the engine k3s and
            // Rancher Desktop run BY DEFAULT, the first call above returns an empty list and the
            // pod holding the database is not missing, it is simply somewhere else. A failure here
            // is swallowed on purpose: an older nerdctl without `--namespace`, or a machine with no
            // Kubernetes at all, must still get the list the first call already produced.
            if cli.cli_type == "nerdctl"
                && let Ok(k8s) = ps_in_namespace(&cli, Some("k8s.io"), target_port, hint)
            {
                let known: std::collections::HashSet<String> =
                    containers.iter().map(|c| c.id.clone()).collect();
                containers.extend(k8s.into_iter().filter(|c| !known.contains(&c.id)));
            }

            // A sandbox can serve none of this panel's actions, so it is removed rather than ranked
            // down: leaving it in a dropdown is offering a choice that cannot work.
            containers.retain(|c| !c.is_sandbox);

            // Best guess first. The two port tests come first because a published port is the
            // strongest evidence there is -- but under Kubernetes there is none, so `matched_name`
            // is what carries the ranking there, and `running` sits above it so a stopped container
            // can never outrank a live one on a name alone.
            containers.sort_by(|a, b| {
                b.matched_host_port
                    .cmp(&a.matched_host_port)
                    .then_with(|| b.matched_container_port.cmp(&a.matched_container_port))
                    .then_with(|| b.running.cmp(&a.running))
                    .then_with(|| b.matched_name.cmp(&a.matched_name))
                    .then_with(|| a.name.cmp(&b.name))
            });

            Ok(containers)
        })
        .await
    })
    .await
}

/// Where a log path actually exists, as far as this machine can see.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogPathProbe {
    /// The path resolves to a real file/directory on THIS machine.
    pub local: bool,
    /// Name or id of the first candidate container that has it, or "" when none does.
    pub container: String,
    /// The CLI was missing, so `container` is "unknown" rather than "no".
    pub cli_missing: bool,
}

/// Answers "is this log path on this machine, or inside one of these containers?".
///
/// The point is to replace an INFERENCE with a test. Guessing from the shape of the path only ever
/// worked on Windows -- a POSIX path there cannot be local, because .NET resolves it against the
/// current drive -- and said nothing on macOS or Linux, where a native server's log lives at a path
/// shaped exactly like a container's. `fs::metadata` and `test -e` answer the same question on
/// every platform, and the answer is evidence rather than a heuristic.
///
/// `candidates` is expected best-first (the caller passes what `list_docker_containers` ranked),
/// because each one costs a process spawn; the scan stops at the first container that has the file
/// and never probes more than `MAX_PROBED_CONTAINERS`.
#[command]
pub async fn probe_log_path(path: String, candidates: Vec<String>) -> Result<LogPathProbe, String> {
    Box::pin(async move {
        blocking("probe log path", move || {
            // A directory counts: `datadir`/`log_directory` are listed rather than tailed, and the
            // caller needs the same answer about where they live.
            let local = std::fs::metadata(&path).is_ok();
            if local {
                return Ok(LogPathProbe {
                    local: true,
                    container: String::new(),
                    cli_missing: false,
                });
            }

            let Some(cli) = find_docker_cli() else {
                return Ok(LogPathProbe {
                    local: false,
                    container: String::new(),
                    cli_missing: true,
                });
            };

            for name in candidates.iter().take(MAX_PROBED_CONTAINERS) {
                // `test -e` rather than `ls`: it says yes/no through the exit status alone, so
                // nothing has to be parsed and a localized `ls` error cannot be mistaken for a hit.
                // A failure to spawn, a stopped container and a missing file are all the same
                // answer here -- not this one -- so they share the branch.
                let ok = silent_command(&cli.binary_path)
                    .arg("exec")
                    .arg(name)
                    .arg("test")
                    .arg("-e")
                    .arg(&path)
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if ok {
                    return Ok(LogPathProbe {
                        local: false,
                        container: name.clone(),
                        cli_missing: false,
                    });
                }
            }

            Ok(LogPathProbe {
                local: false,
                container: String::new(),
                cli_missing: false,
            })
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
        let c = parse_ps_line(LINE, None, None).unwrap();
        assert_eq!(c.id, "abc123");
        assert_eq!(c.name, "my-mysql");
        assert_eq!(c.image, "mysql:8");
        assert_eq!(c.ports, "0.0.0.0:3307->3306/tcp");
        assert!(c.running);
    }

    #[test]
    fn separates_a_host_port_match_from_a_container_port_match() {
        let host = parse_ps_line(LINE, Some(3307), None).unwrap();
        assert!(host.matched_host_port);
        assert!(!host.matched_container_port);

        let inner = parse_ps_line(LINE, Some(3306), None).unwrap();
        assert!(!inner.matched_host_port);
        assert!(inner.matched_container_port);
    }

    #[test]
    fn a_longer_port_does_not_match_a_prefix_of_it() {
        let line = "id\tn\ti\t0.0.0.0:13307->13306/tcp\tUp 1 second";
        let c = parse_ps_line(line, Some(3307), None).unwrap();
        assert!(!c.matched_host_port);
        assert!(!c.matched_container_port);
    }

    #[test]
    fn a_stopped_container_is_listed_and_marked() {
        let line = "id\tpg\tpostgres:16\t\tExited (0) 2 minutes ago";
        let c = parse_ps_line(line, Some(5432), None).unwrap();
        assert!(!c.running);
        // No published ports while stopped, so it can never match one.
        assert!(!c.matched_host_port);
        assert!(!c.matched_container_port);
    }

    #[test]
    fn keeps_a_trailing_empty_field() {
        // Trimming the whole line ate this one and dropped the container without a trace.
        let bare = parse_ps_line("id\tn\ti\t", None, None).unwrap();
        assert_eq!(bare.ports, "");
        assert_eq!(bare.status, "");
    }

    #[test]
    fn a_crlf_ending_does_not_become_part_of_the_last_field() {
        let c = parse_ps_line("id\tn\ti\tp\tUp 2 days\r\n", None, None).unwrap();
        assert_eq!(c.status, "Up 2 days");
        assert!(c.running);
    }

    #[test]
    fn skips_a_line_too_short_to_trust() {
        assert!(parse_ps_line("id\tn\ti", None, None).is_none());
        assert!(parse_ps_line("   ", None, None).is_none());
    }

    // --- Kubernetes ---------------------------------------------------------
    // The name in these cases is the one from a real k3s node under Rancher Desktop.

    const POD_NAME: &str =
        "k8s_POD_coredns-54996dc9b4-w7hsp_kube-system_1aa6026e-fee8-4c3b-8e4e-b0f82d1a56c5_4";

    #[test]
    fn a_pause_container_is_recognised_by_image_on_every_distribution() {
        assert!(is_pause_image("rancher/mirrored-pause:3.6"));
        assert!(is_pause_image("registry.k8s.io/pause:3.9"));
        assert!(is_pause_image("k8s.gcr.io/pause"));
        assert!(is_pause_image("mcr.microsoft.com/oss/kubernetes/pause:3.9"));
        // A registry with a port carries a colon that is not a tag separator.
        assert!(is_pause_image("localhost:5000/pause:3.9"));
        assert!(is_pause_image(
            "registry.k8s.io/pause@sha256:7031c1b28338d2c6e6b9b5f0b1b2f6a0d1c2e3f4a5b6c7d8e9f0a1b2c3d4e5f6"
        ));
    }

    #[test]
    fn an_application_image_is_not_a_pause_image() {
        assert!(!is_pause_image("mysql:8.0.40"));
        assert!(!is_pause_image("rancher/mirrored-coredns-coredns:1.12.0"));
        // Substring matching would have claimed this one.
        assert!(!is_pause_image("acme/pause-service:1.0"));
        assert!(!is_pause_image("acme/unpause"));
    }

    #[test]
    fn the_sandbox_is_filtered_by_image_not_by_name() {
        // The decisive case: under containerd the `k8s_POD_` naming does not exist at all, so a
        // name-based rule would let the sandbox through while the image-based one still catches it.
        let line = "id\tk8s-sandbox-abc\trancher/mirrored-pause:3.6\t\tUp 2 days";
        let c = parse_ps_line(line, None, None).unwrap();
        assert!(c.is_sandbox);
        assert!(c.k8s_container.is_empty(), "not a cri-dockerd name");
    }

    #[test]
    fn a_cri_dockerd_name_splits_into_container_pod_and_namespace() {
        let line = format!("id\t{}\trancher/mirrored-pause:3.6\t\tUp 2 days", POD_NAME);
        let c = parse_ps_line(&line, None, None).unwrap();
        assert!(c.is_sandbox);
        assert_eq!(c.k8s_container, "POD");
        assert_eq!(c.k8s_pod, "coredns-54996dc9b4-w7hsp");
        assert_eq!(c.k8s_namespace, "kube-system");
    }

    #[test]
    fn an_application_container_in_a_pod_keeps_its_own_name() {
        let line = "id\tk8s_mysql_mysql-0_default_1aa6026e-fee8-4c3b-8e4e-b0f82d1a56c5_0\tmysql:8.0.40\t\tUp 2 days";
        let c = parse_ps_line(line, None, Some("mysql")).unwrap();
        assert!(!c.is_sandbox);
        assert_eq!(c.k8s_container, "mysql");
        assert_eq!(c.k8s_pod, "mysql-0");
        assert_eq!(c.k8s_namespace, "default");
        // Kubernetes publishes no docker port, so this is the only evidence available.
        assert!(c.matched_name);
        assert!(!c.matched_host_port);
    }

    #[test]
    fn an_ordinary_docker_name_is_not_parsed_as_kubernetes() {
        let line = "id\tmy_app_container\tmysql:8\t\tUp 2 days";
        let c = parse_ps_line(line, None, None).unwrap();
        assert!(c.k8s_container.is_empty());
        assert!(c.k8s_pod.is_empty());
    }

    #[test]
    fn the_hint_falls_back_to_the_whole_name_outside_kubernetes() {
        let line = "id\tdevtest-mysql-1\tmysql:8\t\tUp 2 days";
        assert!(
            parse_ps_line(line, None, Some("mysql"))
                .unwrap()
                .matched_name
        );
        assert!(
            !parse_ps_line(line, None, Some("postgres"))
                .unwrap()
                .matched_name
        );
        assert!(!parse_ps_line(line, None, None).unwrap().matched_name);
    }

    #[test]
    fn the_hint_reads_the_k8s_container_field_not_the_pod_or_namespace() {
        // The namespace says "mysql" and the container does not: matching the whole name would
        // report a hit and rank the wrong container first.
        let line = "id\tk8s_sidecar_app-0_mysql-ns_1aa6026e-fee8-4c3b-8e4e-b0f82d1a56c5_0\tbusybox\t\tUp 2 days";
        let c = parse_ps_line(line, None, Some("mysql")).unwrap();
        assert_eq!(c.k8s_container, "sidecar");
        assert!(!c.matched_name);
    }
}
