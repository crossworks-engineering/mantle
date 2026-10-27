/** The `pid` template: a P&ID first draft from data. */
export {
  validatePid,
  traceOf,
  TRACE_TABLES_MAX,
  PID_VERSION,
  PID_LIMITS,
  EQUIPMENT_TYPES,
  VALVE_TYPES,
  SIGNAL_TYPES,
  type PidData,
  type TraceSource,
} from './schema.ts';
export { renderPid } from './render.ts';
export {
  validatePidInput,
  renderPidInput,
  validatePidSet,
  renderPidSet,
  isPidSet,
  SET_LIMITS,
  type PidInput,
  type PidSet,
  type PidPage,
} from './set.ts';
export { pidLimitsProblem, RAW_LIMITS } from './limits.ts';
export { DEFAULT_LINE_PATTERN, DEFAULT_SERVICE_COLOURS, type SiteProfile } from './profile.ts';
