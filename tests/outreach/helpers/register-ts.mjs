// Lets `node --test` import the TypeScript pipeline, which uses extension-less
// relative imports ("./config"). Node strips types natively but does not add
// extensions, so this resolve hook tries ".ts" when a bare relative path fails.
import { register } from "node:module";

register(new URL("./resolve-ts-hook.mjs", import.meta.url));
