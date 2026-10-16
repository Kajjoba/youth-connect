import { validationFailed } from '../lib/errors.js';

/**
 * REQ-SEC-005: all input is validated against a schema at the boundary,
 * then the validated object replaces the raw one.
 *
 * The replacement matters. If the handler keeps reading req.body it can
 * still see fields the schema stripped, which is how mass-assignment
 * bugs happen: a client posts {"role":"admin"} to a profile update and
 * an over-eager spread operator promotes them. Here the handler can only
 * ever see whitelisted fields.
 *
 * Validating on the client as well is a usability feature, not a
 * security one. Client validation is advisory; this is the control.
 */
export function validate(schemas) {
  return function validateMiddleware(req, res, next) {
    const details = {};

    for (const source of ['body', 'query', 'params']) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);
      if (!result.success) {
        for (const issue of result.error.issues) {
          const key = issue.path.join('.') || source;
          if (!details[key]) details[key] = issue.message;
        }
        continue;
      }

      if (source === 'query') {
        // req.query is a getter-only property on Express 5 style routers.
        req.validatedQuery = result.data;
      } else {
        req[source] = result.data;
      }
    }

    if (Object.keys(details).length) {
      return next(validationFailed(details));
    }
    return next();
  };
}
