# Workstation CI runner

build-check can run our own pushes on a workstation instead of a GitHub
machine: more cores, so the test suites finish sooner. Pull requests always
stay on GitHub's machines.

## Switch

- On: `gh variable set CI_SELF_HOSTED --body on -R crossworks-engineering/mantle`
- Off: the same with `--body off`. Do this when the workstation is down or
  the runner is stopped: while it is on, every push to main or `feat/**`
  waits for the workstation (GitHub does not fall back by itself).

`build-check.yml` reads the variable in `runs-on` and in `CI_DATABASE_URL`
(the test database answers on the `dind` host there, not on localhost).

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
runners: the loop asks it for a registration token for each job.

Logs: `journalctl --user -u mantle-ci-runner@1 -f`.
Stop: `systemctl --user disable --now mantle-ci-runner@1`, then switch it off.

## How it is kept apart from the workstation

Each job gets, and then loses:

- its own Docker daemon (a `docker:dind` container) on a private network,
  with its own data volume: the job's service containers (Postgres) run
  there, never on the host's Docker;
- its own runner container, registered for that one job (`--ephemeral`),
  removed when the job ends, together with the dind container, the network
  and both volumes.

The runner container mounts no host folder and has no host Docker socket.
It never sees the host's SSH keys or gh login. The only secret it gets is the
registration token, which can only register a runner, is removed from the
environment before the job starts, and expires within the hour. The job's
own `GITHUB_TOKEN` has `contents: read` (build-check has no secrets).

Only push events use it: a pull request runs the workflow file of the PR, so
it could ask for this runner by label. Two guards stop that: `runs-on` sends
pull requests to GitHub, and the repo makes every outside contributor's
pull request wait for a maintainer's approval
(`fork-pr-contributor-approval` = `all_external_contributors`). Never
approve a fork pull request that changes a workflow file.

## What is still a risk

- The dind container is privileged, as a Docker daemon must be. A job that
  breaks out of it on purpose reaches the host kernel. Only code we push
  runs here, but that includes every dependency's install script.
- The runner container can reach the network, the workstation's own open
  ports included (it sits on a Docker bridge).
- One runner takes one job at a time; a second slot is
  `mantle-ci-runner@2` (each slot has its own dind). Size them with
  `MANTLE_CI_CPUS` and `MANTLE_CI_MEM` (defaults 12 CPUs, 16 GB) in a unit
  drop-in, so builders on the workstation keep room.
