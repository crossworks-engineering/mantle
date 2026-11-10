# Workstation CI runner

build-check can run our own pushes on a workstation instead of a GitHub
machine: more cores, so the test suites finish sooner. Pull requests always
stay on GitHub's machines.

## Switch

- On: `gh variable set CI_SELF_HOSTED --body on -R crossworks-engineering/mantle`
- Off: the same with `--body off`. Do this when the workstation is down or
  the runner is stopped: while it is on, every push to main or `feat/**`
  waits for the workstation (GitHub does not fall back by itself).

`build-check.yml` reads the variable in three places: `runs-on`, the
Postgres service (skipped on the workstation, where the loop starts its own)
and `CI_DATABASE_URL` (host `pg` there, `localhost` on GitHub).

## Set up (on the workstation)

```sh
mkdir -p ~/ci-runner && cp infra/ci-runner/runner-loop.sh ~/ci-runner/ && chmod +x ~/ci-runner/runner-loop.sh
docker build -t mantle-ci-runner:2.338.2 infra/ci-runner
cp 'infra/ci-runner/mantle-ci-runner@.service' ~/.config/systemd/user/
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now mantle-ci-runner@1
```

`gh` must be logged in on the host with a token that may manage the repo's
runners: the loop asks it for a registration token for each job. Better: a
fine-grained token for this repo only (Administration read and write), given
to the loop as `GH_TOKEN` in a unit drop-in, so the loop does not hold the
full login.

After a change to `runner-loop.sh`, copy it again and restart the unit (a
job that runs at that moment is cut off; restart between jobs):

```sh
cp infra/ci-runner/runner-loop.sh ~/ci-runner/runner-loop.sh
systemctl --user restart mantle-ci-runner@1
```

Logs: `journalctl --user -u mantle-ci-runner@1 -f`.
Stop: `systemctl --user disable --now mantle-ci-runner@1` (the unit removes
the containers), then switch it off. A runner stopped while it waited for a
job stays listed as offline in the repo's runners until GitHub drops it
(about a day); it takes no jobs.

The runner is pinned (2.338.2, no self-update). GitHub stops sending jobs to
an old runner some weeks after a new release: rebuild the image on the new
version (Dockerfile and `IMAGE` in runner-loop.sh) when a release comes out.

## How it is kept apart from the workstation

Each job gets, and then loses:

- a Postgres container (`pgvector/pgvector:pg18`, host `pg`) on a private
  network, with its own data volume, `max_connections=300` (the default 100
  ran out: a CI-style run peaked at 82) and a 256 MB `/dev/shm`. Change the
  limit with `MANTLE_CI_PG_CONNS` and its memory cap (4 GB) with
  `MANTLE_CI_PG_MEM` in a unit drop-in. GitHub's own Postgres service keeps
  the default 100;
- a runner container, registered for that one job (`--ephemeral`), removed
  with the rest when the job ends.

The runner container has **no Docker**: no socket, no daemon, no client
certs. (A job that can start containers can start a privileged one that
mounts the host's disk; this is why there is no Docker-in-Docker here.) It
mounts no host folder, never sees the host's SSH keys or gh login, runs with
no capabilities and `no-new-privileges` (so no sudo), and a process cap. The
only secret it gets is the registration token, which can only register a
runner and is gone from the environment before the job starts. (On the host
it shows in `docker inspect` of the runner container, for the docker group,
which can do more than that anyway; not in `ps`.) The job's
own `GITHUB_TOKEN` has `contents: read` (build-check has no secrets).

Only our pushes to build-check run here, by three locks:

1. `runs-on` sends every pull request to GitHub;
2. the runner's job-started hook (`guard-job.sh`, baked into the image)
   refuses any job that is not a `push` run of `build-check.yml` in this
   repository; a workflow cannot set the `GITHUB_*` values it reads. A pull
   request runs its own workflow files and could name this label; the hook
   is what refuses it. A failed hook alone would still let steps marked
   `if: always()` run, so the hook kills the runner process: no step of a
   refused job runs here. It runs before "Initialize containers" and before
   any step;
3. every outside contributor's pull request waits for a maintainer's
   approval (`fork-pr-contributor-approval` = `all_external_contributors`).
   Never approve a fork pull request that changes a workflow file.

## What is still a risk

- The job runs our code and every dependency's code on the workstation's
  kernel (in a container). A dependency that attacks the container runtime
  itself would need a kernel or runtime exploit.
- The runner container can reach the network, the workstation's own open
  ports and the private networks it routes to (it sits on a Docker bridge).
  This is no more than the code builders already run straight on the
  workstation, but it is open. Two ways to close it: an `--internal`
  network for the runner and `pg` plus a small proxy container that lets
  out only GitHub, npm, PyPI and nodejs.org (`HTTPS_PROXY` in the runner);
  or firewall rules for the bridge (`DOCKER-USER` and `INPUT`), which is a
  change to the workstation's own firewall.
- One runner takes one job at a time; a second slot is
  `mantle-ci-runner@2`. Size them with `MANTLE_CI_CPUS` and `MANTLE_CI_MEM`
  (defaults 12 CPUs, 16 GB) in a unit drop-in, so builders on the
  workstation keep room.
