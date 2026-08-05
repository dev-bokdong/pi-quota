import { describe, expect, it } from "vitest";
import { clampPercent } from "../src/types.ts";

describe("clampPercent", () => {
	it("keeps values already within 0-100", () => {
		expect(clampPercent(42)).toBe(42);
	});

	it("clamps values above 100 down to 100", () => {
		expect(clampPercent(137)).toBe(100);
	});

	it("clamps negative values up to 0", () => {
		expect(clampPercent(-12)).toBe(0);
	});

	it("rounds fractional values to the nearest integer", () => {
		expect(clampPercent(63.6)).toBe(64);
		expect(clampPercent(63.4)).toBe(63);
	});

	it("treats NaN as 0", () => {
		expect(clampPercent(Number.NaN)).toBe(0);
	});
});
