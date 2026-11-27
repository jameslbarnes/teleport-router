// Sends every import of the server's identity module to ./identity.mjs, except the one ./identity.mjs makes itself.
const wrapper = new URL('./identity.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  if (/\/src\/identity\.ts$/.test(result.url) && context.parentURL !== wrapper) return { ...result, url: wrapper, shortCircuit: true };
  return result;
}
