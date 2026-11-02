#!/usr/bin/env bash
# runs-on: box. Inside the CI runner container (Ubuntu): bash, procps.
# Job-started hook of the workstation runner (ACTIONS_RUNNER_HOOK_JOB_STARTED).
# It runs before the job's first step and fails the job unless it is a push
# run of build-check in this repository. A pull request runs its OWN workflow
# files, so a PR could name this runner's label; this hook is the runner's own
# refusal, not the workflow's. A workflow cannot set GITHUB_* variables.
set -u
want_repo="crossworks-engineering/mantle"
want_wf="$want_repo/.github/workflows/build-check.yml@refs/heads/"

ok=1
[ "${GITHUB_EVENT_NAME:-}" = "push" ] || ok=0
[ "${GITHUB_REPOSITORY:-}" = "$want_repo" ] || ok=0
case "${GITHUB_WORKFLOW_REF:-}" in "$want_wf"*) ;; *) ok=0 ;; esac

if [ "$ok" != 1 ]; then
  echo "::error::this runner takes push runs of build-check in $want_repo only (got event '${GITHUB_EVENT_NAME:-}', workflow '${GITHUB_WORKFLOW_REF:-}')"
  # A failed hook fails the job, but the runner still runs any later step
  # marked if: always() or failure(). So end the runner itself: no step of
  # this job can run here. The container exits and the loop cleans up.
  pkill -KILL -f 'Runner\.(Worker|Listener)'
  exit 1
fi
echo "runner guard: push run of build-check, ok"
