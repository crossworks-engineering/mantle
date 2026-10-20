/** Types of session-guards.mjs (the one list of the guard names). */
export declare const SESSION_GUARDS: readonly string[];
export declare const CALLER_READERS: readonly string[];
export declare const READER_ANSWERS: Readonly<
  Record<
    string,
    Readonly<{
      caller:
        | 'owner'
        | 'member'
        | 'login'
        | 'chat'
        | 'session'
        | 'ownerAsset'
        | 'readerAsset'
        | 'frame'
        | 'publicLogin'
        | 'cookieUpgrade'
        | 'ownerAtRead';
      guard: string | null;
      entry: string;
      atRead?: true;
      logs?: string;
    }>
  >
>;
export declare const RETIRED_GUARDS: readonly string[];
