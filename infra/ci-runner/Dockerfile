# The workstation CI runner (see README.md): GitHub's own runner image plus
# what build-check needs that it lacks, and the job guard. Built on the
# workstation:
#   docker build -t mantle-ci-runner:2.338.2 infra/ci-runner
FROM ghcr.io/actions/actions-runner:2.338.2

USER root
# python3-venv: the parser CAD tier makes a venv. build-essential: native
# modules that have no prebuilt binary for this Node. Nothing else: the
# workflow installs Node and pnpm itself.
# postgresql-client-18: pg_dump and pg_restore at least as new as the test
# server (dump-restore.db.test.ts), from the PostgreSQL apt repository.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-venv build-essential ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && rm -rf /var/lib/apt/lists/*
# The loop mounts an anonymous volume here; Docker copies this folder's owner
# into it, so the runner (not root) can write its work tree.
RUN mkdir -p /home/runner/_work && chown runner:runner /home/runner/_work
COPY --chmod=0555 guard-job.sh /opt/guard-job.sh
ENV ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/guard-job.sh
USER runner
