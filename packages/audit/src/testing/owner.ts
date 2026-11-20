/**
 * The owner role's two names, from the one place that pins them (ticket
 * #165).
 *
 * A RELATIVE-PATH RE-EXPORT, which is this repo's convention for test
 * plumbing that needs another package's source: every package's `src/testing`
 * is excluded from its build (`tsconfig.build.json`), so nothing here reaches
 * `@dito/audit`'s dependency graph, and `@dito/aperture` — which depends on
 * this package — is never named as a package dependency. The owner twin's own
 * `src/testing/db.ts` and the owner web's `src/testing` re-export reach these
 * same two constants the same way.
 *
 * WHY NOT TWO STRING LITERALS in the suite: `grants.ts` pins both precisely
 * so "the owner app, its tools and its tests all name it from one place
 * rather than three string literals that can drift apart". The owner chain's
 * suite connects AS the role and declares a company through the setting, so
 * it is one of those tests.
 */
export {
  OWNER_COMPANY_SETTING,
  OWNER_ROLE,
} from "../../../aperture/src/grants.js";
