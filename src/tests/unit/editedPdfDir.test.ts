import path from "path";
import { editedPdfDirForType, DOCUMENT_TYPES } from "../../config/documentTypes";

describe("editedPdfDirForType", () => {
    const hw = path.join("F:", "PDF_output", "Production_BOM", "Hardware");
    const sibling = (name: string) => path.join(path.dirname(hw), name);

    it("puts each PBOM type into its own Production_BOM folder", () => {
        expect(editedPdfDirForType(hw, DOCUMENT_TYPES.PBOM_HARDWARE)).toBe(hw);
        expect(editedPdfDirForType(hw, DOCUMENT_TYPES.PBOM_MOTOR)).toBe(sibling("Motor"));
        expect(editedPdfDirForType(hw, DOCUMENT_TYPES.PBOM_FIXED_TOP_PANEL)).toBe(sibling("Fixed_top_panel"));
        expect(editedPdfDirForType(hw, DOCUMENT_TYPES.PBOM_PREASSEMBLED_SHAFT)).toBe(sibling("Preassembled_shaft"));
    });

    it("keeps non-PBOM and unknown types in the configured folder", () => {
        expect(editedPdfDirForType(hw, null)).toBe(hw);
        expect(editedPdfDirForType(hw, DOCUMENT_TYPES.CUSTOMER_BOM)).toBe(hw);
        expect(editedPdfDirForType(hw, 999)).toBe(hw);
    });
});
