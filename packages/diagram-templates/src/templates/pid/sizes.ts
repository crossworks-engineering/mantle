/**
 * The sizes the `pid` template holds a drawing and a set to, in a module
 * of their own that imports nothing: the template's check (schema.ts,
 * set.ts) runs the raw bounds (limits.ts pidLimitsProblem) first, and
 * those bounds are built from these, so neither imports the other's
 * module while it loads.
 */

/** Hard limits (errors) and the guide's complexity budget (warnings). */
export const PID_LIMITS = {
  equipment: 30,
  lines: 60,
  instruments: 60,
  offpage: 20,
  tees: 30,
  signals: 60,
  circuits: 12,
  /** Valves and reducers drawn on one line. */
  inline: 6,
  /** The longest text a field takes, in characters. */
  text: {
    title: 80,
    description: 300,
    /** An off-page connector's text. */
    connector: 40,
    /** A line's "+N" marker. */
    marker: 32,
    /** A line's number. */
    lineNumber: 40,
    /** A line's note. */
    note: 32,
    /** A circuit's label. */
    circuitLabel: 40,
  },
  budget: {
    equipment: 8,
    instruments: 16,
    valves: 20,
    loops: 5,
    lines: 12,
    lineTypes: 4,
    accents: 2,
  },
};

/** The pages a set holds, and the longest page title (the page bar's). */
export const SET_LIMITS = { pages: 40, pageTitle: 60 } as const;
