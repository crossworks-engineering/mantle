/**
 * Optional services: the box services an admin can switch on and off from
 * the dashboard (sandboxes, media). GET /api/services returns a
 * {@link ServicesView}; POST /api/services/:name {enable} asks the updater
 * sidecar to switch one; GET /api/services/status is the progress poll.
 */

export type OptionalServiceName = 'sandboxes' | 'media';

/**
 * - `off`: the compose profile is not active (the resting state).
 * - `up`: on and answering its health probe.
 * - `down`: on but not answering (starting, crashed, or misconfigured).
 */
export type ServiceState = 'off' | 'up' | 'down';

/** Plain-language facts the UI shows next to the switch. Brain-authored, so
 *  the sizes stay next to the compose file they describe. */
export type ServiceDescription = {
  title: string;
  /** What it does, one or two sentences. */
  what: string;
  /** Which features use it. */
  usedBy: string;
  /** What stops working while it is off. */
  whenOff: string;
  /** What switching it off keeps (never removed). */
  keeps: string;
  /** Approximate first download, in MB (compressed). */
  downloadMb: number;
  /** Memory, as a short phrase ("up to 1 GB"). */
  memory: string;
  /** Upper bound in MB, for the small-box warning. */
  memoryMaxMb: number;
  /** A security note, when the service carries one. */
  note: string | null;
};

export type ServiceInfo = {
  name: OptionalServiceName;
  state: ServiceState;
  /** The container as docker reports it ('running', 'exited', 'absent'),
   *  and its healthcheck ('healthy', 'starting', 'none'). Null when the
   *  updater has not reported yet. */
  container: string | null;
  health: string | null;
  description: ServiceDescription;
};

/** One switch run, from the updater's service-status.json. */
export type ServiceRunPhase =
  'idle' | 'requested' | 'pulling' | 'starting' | 'stopping' | 'done' | 'error';

export type ServiceRunStatus = {
  phase: ServiceRunPhase;
  service: OptionalServiceName | null;
  enable: boolean | null;
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean | null;
  error: string | null;
};

export type ServicesView = {
  services: ServiceInfo[];
  /** Whether this box can switch services from the UI, and why not. */
  switching: {
    available: boolean;
    /** Null when available. */
    reason: string | null;
  };
  box: {
    memTotalBytes: number | null;
    memAvailableBytes: number | null;
    diskFreeBytes: number | null;
    /** The 4 GB brain-core shape. */
    core: boolean;
    /** A box this small should be warned before a service goes on. */
    smallBox: boolean;
  };
  /** The current or last switch run. */
  run: ServiceRunStatus | null;
};

export type ServiceSwitchResult = { ok: true } | { ok: false; error: string };

export type ServiceRunPoll = {
  run: ServiceRunStatus | null;
  /** Tail of the run's output (service.log). */
  log: string;
};
