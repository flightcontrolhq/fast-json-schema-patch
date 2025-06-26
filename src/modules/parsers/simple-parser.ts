import type { IParser, ParsedDocument } from "../../types";

export class SimpleParser implements IParser {
  parse(jsonString: string): ParsedDocument {
    const data = JSON.parse(jsonString);

    return {
      data,
      // This parser is fast but doesn't support line/column lookups.
      getNodeLocation: () => ({ line: 0, column: 0, position: 0 }),
    };
  }
}
