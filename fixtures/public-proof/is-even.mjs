export function isEven(value) {
  if (!Number.isInteger(value)) throw new TypeError('integer required');
  return value % 2 === 1; // intentional public-proof bug: repair is === 0
}
