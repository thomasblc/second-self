// Imported FIRST by server.js (before any module that pulls in node:sqlite) so the filter is in
// place before the experimental-SQLite warning would fire. ESM evaluates a module's imports
// depth-first in source order, so this side effect runs before the connector modules load.
// We only silence the one known, benign warning; every other warning still surfaces.
const _emit = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const opt = rest[0];
  const type = (opt && typeof opt === "object") ? opt.type : opt;
  if (type === "ExperimentalWarning" && /SQLite/i.test(String(warning))) return;
  return _emit(warning, ...rest);
};
