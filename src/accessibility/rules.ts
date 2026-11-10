import type { AccessibilityRule } from "../types/accessibility";

export const accessibilityRules: Record<string, AccessibilityRule> = {

    // NOTE FOR FUTURE: The default severity is "error", but future scanner should only report when it has enough evidence. 

"image-text-alternative":{
  id: "image-text-alternative",
  title: "Image Text Alternative",
  description:
  "Images must have an appropriate text alternative so people using screen readers can understand their content or purpose.",
  remediation: 'Provide meaningful alternative text using the alt attribute. Decorative images should use alt="". Other accessible naming mechanisms, such as aria-label or aria-labelledby, may also provide a text alternative.',
  category: "Images",
  severity: "error",
  wcagCriteria: ["1.1.1"],
},
"form-control-name":{
    id: "form-control-name",
    title: "Form Control Accessible Name",
    description:
    "Form controls must have accessible names so assistive technologies can identify their purpose.",
    remediation: "Associate form inputs with descriptive <label> elements using for and id, wrap controls inside labels, or use an appropriate accessible naming mechanism such as aria-label or aria-labelledby. Do not rely on placeholder text as the only label.",
    category: "Forms",
    severity: "error",
    wcagCriteria: ["4.1.2"],
},
    "button-name":{
    id: "button-name",
    title: "Button Accessible Name",
    description:
    "Buttons must have accessible names that communicate their function to assistive technology users.",
    remediation: "Add descriptive text inside the button or supply an accessible name using aria-label or aria-labelledby. Icon-only buttons must also have an accessible name.",
    category: "Controls",
    severity: "error",
    wcagCriteria: ["4.1.2"],
  },
  "link-name":{
    id: "link-name",
    title: "Link Accessible Name",
    description:
    "Links must have accessible names so users of assistive technologies can identify them and understand their purpose.",
    remediation: "Provide descriptive link text or an appropriate accessible name using aria-label or aria-labelledby. Image-only links must have an accessible text alternative.",
    category: "Navigation",
    severity: "error",
    wcagCriteria: ["2.4.4", "4.1.2"],
  },
  "document-language":{
    id: "document-language",
    title: "Document Language",
    description:
    "Web pages must declare their default language so assistive technologies can interpret and pronounce content correctly.",
    remediation: 'Specify the primary language using the lang attribute on the root <html> element, such as lang="en" or lang="fr".',
    category: "Language",
    severity: "error",
    wcagCriteria: ["3.1.1"],
  },
  "iframe-name":{
    id: "iframe-name",
    title: "iframe Accessible Name",
    description:
    "Embedded frames must have accessible names that identify their content or purpose, allowing assistive technology users to distinguish between frames.",
    remediation: "Provide a descriptive title attribute on the <iframe> element. An appropriate ARIA accessible naming mechanism may also be used.",
    category: "Embedded Content",
    severity: "error",
    wcagCriteria: ["4.1.2"],
  },
};

export function getRule(id: string): AccessibilityRule | undefined {
    // function to return the accessibility rule metadata with a specific id
    return accessibilityRules[id];
}
