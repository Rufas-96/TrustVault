'use strict';

// Access reviews: a grant goes "stale" when its owner has not confirmed it is still needed for
// REVIEW_AFTER_DAYS (counted from the grant, or from the last confirmation). Stale grants keep
// working; the point is to put them in front of the owner, so access that outlived its purpose
// (a leaver, a finished contract) gets noticed and revoked instead of lingering forever.
const REVIEW_AFTER_DAYS = 30;
const REVIEW_AFTER_MS = REVIEW_AFTER_DAYS * 24 * 3600 * 1000;

// SQL expression for "when this grant was last confirmed", for a permissions row aliased p.
const LAST_CONFIRMED_SQL = 'COALESCE(p.reviewed_at, p.granted_at)';

module.exports = { REVIEW_AFTER_DAYS, REVIEW_AFTER_MS, LAST_CONFIRMED_SQL };
