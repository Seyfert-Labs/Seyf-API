import { describe, expect, it } from "vitest";
import { formatUnits, parseUnits } from "../src/core/units.js";

describe("formatUnits", () => {
  it("formatea unidades a decimal canónico sin ceros de cola", () => {
    expect(formatUnits(0n, 7)).toBe("0");
    expect(formatUnits(10_000_000n, 7)).toBe("1");
    expect(formatUnits(12_345_678n, 7)).toBe("1.2345678");
    expect(formatUnits(1_500_000n, 7)).toBe("0.15");
    expect(formatUnits(100n, 2)).toBe("1");
  });

  it("evita la notación científica que produciría la división en coma flotante", () => {
    // El enfoque de SEYF-P (raw / 10 ** d) daría "1e-7": un string que un
    // cliente que parsea decimales no interpreta como monto.
    expect(String(1 / 10 ** 7)).toBe("1e-7");
    expect(formatUnits(1n, 7)).toBe("0.0000001");
  });

  it("maneja montos grandes sin perder dígitos", () => {
    expect(formatUnits(123_456_789_012_345_678n, 7)).toBe("12345678901.2345678");
  });

  it("preserva el signo negativo", () => {
    expect(formatUnits(-12_345_678n, 7)).toBe("-1.2345678");
  });

  it("con 0 decimales devuelve el entero", () => {
    expect(formatUnits(42n, 0)).toBe("42");
  });
});

describe("parseUnits", () => {
  it("convierte decimales a unidades enteras", () => {
    expect(parseUnits("1", 7)).toBe(10_000_000n);
    expect(parseUnits("1.2345678", 7)).toBe(12_345_678n);
    expect(parseUnits("0.15", 7)).toBe(1_500_000n);
    expect(parseUnits("-1.5", 7)).toBe(-15_000_000n);
  });

  it("rechaza montos con más precisión que el activo", () => {
    expect(() => parseUnits("1.12345678", 7)).toThrow(/precisión/);
  });

  it("rechaza entradas que no son montos", () => {
    for (const bad of ["", "abc", "1.2.3", "1e7", " ", "--1"]) {
      expect(() => parseUnits(bad, 7)).toThrow();
    }
  });

  it("es inverso de formatUnits", () => {
    for (const raw of [0n, 1n, 10_000_000n, 12_345_678n, 999_999_999_999n]) {
      expect(parseUnits(formatUnits(raw, 7), 7)).toBe(raw);
    }
  });
});
