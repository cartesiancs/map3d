/** Only evidence of an expensive Overpass query should trigger query splitting. */
export function isQueryFailure(status: number, detail = '') {
  if (![200, 408, 500, 504].includes(status)) return false;
  return /query timed out|query timeout|out of memory|exceeded.*(?:memory|runtime)|runtime.*exceeded/i.test(detail);
}

export function isServiceFailure(status: number) {
  return [403, 406, 429, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530].includes(status);
}

export function serviceBackoff(failures: number, status?: number) {
  // Origin connection failures cannot be repaired by changing the boundary.
  const minimum = status === 521 || status === 403 || status === 406 ? 120000 : 30000;
  return Math.min(120000, minimum * 2 ** Math.max(0, failures - 1));
}
