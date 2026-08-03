// Aritmética de montos con precisión exacta.
//
// Los saldos viajan como enteros ("unidades", 10^decimals) y se presentan como
// strings decimales. Deliberadamente NO se usa `number`: dividir entre 10^7 en
// coma flotante introduce errores de redondeo en saldos de dinero real
// (SEYF-P lo hace con `raw / 10 ** d`). El contrato de la API expone strings
// por la misma razón.

/** Convierte unidades enteras a string decimal canónico, sin ceros de cola. */
export function formatUnits(raw: bigint, decimals: number): string {
  if (decimals < 0) throw new RangeError("decimals no puede ser negativo");
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, "0");

  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, "") : "";

  const value = fraction ? `${whole}.${fraction}` : whole;
  return negative && value !== "0" ? `-${value}` : value;
}

/** Convierte un string decimal a unidades enteras. Lanza si el input no es válido o excede la precisión. */
export function parseUnits(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new RangeError(`Monto inválido: ${amount}`);

  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > decimals) {
    throw new RangeError(`El monto excede la precisión del activo (${decimals} decimales)`);
  }

  const units = BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
  return sign === "-" ? -units : units;
}
