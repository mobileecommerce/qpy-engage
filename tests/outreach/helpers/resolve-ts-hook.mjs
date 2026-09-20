import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/i.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    try {
      await access(fileURLToPath(candidate));
      return next(candidate.href, context);
    } catch {
      /* fall through to the default resolver */
    }
  }
  return next(specifier, context);
}
