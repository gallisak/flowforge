export function supportedTimezones(): string[] {
  return Intl.supportedValuesOf('timeZone');
}
