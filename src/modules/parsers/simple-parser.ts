import type { IParser, JsonValue, ParsedDocument } from "../../types";

export class SimpleParser implements IParser {
  parse(jsonString: string): ParsedDocument {
    const data: JsonValue = JSON.parse(jsonString);

    return {
      data,
      getNodeLocation: (_path: string) => {
        return { line: 0, column: 0, position: 0 };
      },
    };
  }
}
