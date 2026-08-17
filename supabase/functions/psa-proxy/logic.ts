/**
 * The pure half of `psa-proxy` — what may be asked, and how long an answer is
 * worth keeping. `index.ts` fetches; this file decides. The same split
 * `ebay-comps/logic.ts` uses, and for the same reason: the function is
 * anonymous by design, so everything standing between the open internet and
 * our PSA credential is decided here, where it can be tested without a
 * network or a token.
 */

/**
 * PSA certs run 8–9 digits today; the cap is headroom, not a spec claim. The
 * point of a hard bound is not tidiness: whatever passes this check is
 * forwarded upstream **under our token**, so an unauthenticated caller must
 * not be able to push arbitrary strings through us. A "cert" longer than this
 * is not a lookup, it is a probe.
 */
export const MAX_CERT_DIGITS = 12

/**
 * Validate a cert strictly: bare digits, bounded, or nothing.
 *
 * No cleaning happens here on purpose. `psa.ts` already strips non-digits
 * before it calls (`cert.replace(/\D/g, '')`), so anything else arriving is
 * not our client being sloppy — it is somebody else's input, and the answer
 * to that is no. A second, more forgiving parser here would just be a place
 * for the two to drift apart. Leading zeros are kept: they are part of the
 * number as printed on the label, PSA accepts them, and the digits are also
 * the cache key.
 */
export function certParam(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cert = raw.trim()
  if (!/^\d+$/.test(cert)) return null
  if (cert.length > MAX_CERT_DIGITS) return null
  return cert
}

/**
 * The cert rides the path — `psa.ts` requests `GET {endpoint}/{cert}` — so it
 * is the last path segment, validated. Percent-escapes are deliberately NOT
 * decoded: `encodeURIComponent` never escapes a digit, so a genuine cert
 * arrives literal, and an escaped one ("%31%32") is by definition not
 * something our client sent.
 */
export function certFromPath(pathname: string): string | null {
  const last = (pathname ?? '').split('/').filter(Boolean).pop() ?? ''
  return certParam(last)
}

/** Case-insensitive, emptiness-aware field read — the same tolerance `psa.ts`
 * applies, because PSA's field casing differs between their docs and their
 * endpoints and we cannot verify the live shape from a build environment. */
function field(source: Record<string, unknown>, ...names: string[]): unknown {
  const lower = new Map(Object.keys(source).map((key) => [key.toLowerCase(), key]))
  for (const name of names) {
    const actual = lower.get(name.toLowerCase())
    if (actual != null && source[actual] != null && source[actual] !== '') return source[actual]
  }
  return undefined
}

/**
 * Does a 200 from PSA actually name a graded card?
 *
 * This mirrors the emptiness test in `psa.ts` (a record with no subject, no
 * brand and no grade is "not found") — including the grade-arriving-only-in-
 * words case ("GEM MT 10" in `GradeDescription`). The client stays the
 * authority on what a record MEANS; this only chooses a cache TTL, because
 * the two truths age differently: a found cert is immutable — PSA never
 * regrades a cert number, it issues a new one — while "no record for cert N"
 * can become true later, since certs are minted every day. Misclassifying
 * costs a suboptimal TTL, never a wrong answer.
 */
export function certFound(payload: unknown): boolean {
  if (payload == null || typeof payload !== 'object') return false
  const root = payload as Record<string, unknown>
  const wrapped = field(root, 'PSACert', 'psaCert', 'cert')
  const inner = wrapped != null && typeof wrapped === 'object' ? (wrapped as Record<string, unknown>) : root
  if (field(inner, 'Subject', 'playerName') != null) return true
  if (field(inner, 'Brand') != null) return true
  if (Number.isFinite(Number(field(inner, 'CardGrade', 'grade', 'gradeValue')))) return true
  return field(inner, 'GradeDescription') != null
}
