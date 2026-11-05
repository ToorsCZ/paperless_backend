jest.mock("../../config/database");

import { changedLocks, isLockedValue } from "../../services/masterplanLockService";

describe("changedLocks", () => {
    it("logs new positions and changed values only — including 0 vs empty", () => {
        const last = new Map<string, number | null>([["605278::10", null], ["605278::20", 2], ["605278::30", 0]]);
        const current = new Map<string, number | null>([
            ["605278::10", null], // unchanged
            ["605278::20", 0], // unlocked
            ["605278::30", null], // 0 → empty
            ["605278::50", 1], // first seen
        ]);
        expect(changedLocks(last, current)).toEqual([["605278::20", 0], ["605278::30", null], ["605278::50", 1]]);
    });

    it("1 (automatic) and 2 (by a user) are locked", () => {
        expect([0, 1, 2, null].map(isLockedValue)).toEqual([false, true, true, false]);
    });
});
