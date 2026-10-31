import { reportCodes } from '@emporium/shared';
import type { FastifyInstance } from 'fastify';

export interface RouteRef {
  method: string;
  /** The route pattern, for example `/projects/:id/activate`. */
  pattern: string;
}

/** Every route of the app, read from Fastify's route tree (HEAD mirrors GET and OPTIONS is the CORS preflight, so both are skipped). */
export function listRoutes(app: FastifyInstance): RouteRef[] {
  const routes: RouteRef[] = [];
  const stack: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const match = /^((?:│ {3}| {4})*)[├└]── (\S+)(?: \(([^)]*)\))?$/.exec(line);
    if (!match) continue;
    const depth = (match[1] ?? '').length / 4;
    stack.length = depth;
    // The tree merges sibling parameter names as `:id|:team`; one name is enough to call it.
    const segment = (match[2] ?? '').replace(/(:[A-Za-z]+)\|:[A-Za-z]+/, '$1');
    stack.push(segment);
    for (const method of (match[3] ?? '')
      .split(', ')
      .filter((m) => m !== '' && m !== 'HEAD' && m !== 'OPTIONS')) {
      routes.push({ method, pattern: stack.join('') });
    }
  }
  return routes.sort((a, b) =>
    `${a.pattern} ${a.method}`.localeCompare(`${b.pattern} ${b.method}`),
  );
}

/**
 * A route that is open to a family of values is probed once per value. The report endpoint checks
 * its permission after parsing the report code, so a made-up code would hide the permission check.
 */
export function expandRoute(route: RouteRef): RouteRef[] {
  if (route.pattern === '/reports/:code') {
    return reportCodes.map((code) => ({ method: route.method, pattern: `/reports/${code}` }));
  }
  return [route];
}

const SAMPLE_ID = '018f9000-0000-7000-8000-00000000ffff';

/** A callable URL for a route: path parameters become a well-formed id (unknown, so nothing real is touched). */
export function urlFor(route: RouteRef): string {
  return route.pattern.replace(/:[A-Za-z]+/g, (name) =>
    name === ':code' || name === ':key' || name === ':docType' ? 'x' : SAMPLE_ID,
  );
}
