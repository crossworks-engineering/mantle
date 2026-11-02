# The workstation CI runner (see README.md): GitHub's own runner image plus
# what build-check needs that it lacks, and the job guard. Built on the
# workstation:
#   docker build -t mantle-ci-runner:2.338.2 infra/ci-runner
FROM ghcr.io/actions/actions-runner:2.338.2

USER root
# python3-venv: the parser CAD tier makes a venv. build-essential: native
# modules that have no prebuilt binary for this Node. Nothing else: the
# workflow installs Node and pnpm itself.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-venv build-essential \
 && rm -rf /var/lib/apt/lists/*
COPY --chmod=0555 guard-job.sh /opt/guard-job.sh
ENV ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/guard-job.sh
USER runner
