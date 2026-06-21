// tz-lookup ships no types. It's a single CommonJS function mapping a
// coordinate to its IANA timezone name from bundled boundary data (offline,
// deterministic). Throws a RangeError on out-of-range input.
declare module 'tz-lookup' {
  export default function tzlookup(latitude: number, longitude: number): string;
}
