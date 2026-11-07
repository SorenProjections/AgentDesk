/** @param {string[]} secrets */
export function createRedactor(secrets = []) {
  const known = secrets.filter(s => s.length >= 4).sort((a, b) => b.length - a.length);
  /** @param {string} input */
  return input => {
    let result = input;
    for (const secret of known) result = result.split(secret).join('[redacted]');
    return result.replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
      .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}/g, '[redacted]');
  };
}
