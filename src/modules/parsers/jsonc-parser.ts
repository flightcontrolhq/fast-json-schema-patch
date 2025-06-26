import type { IParser, JsonValue, ParsedDocument } from "../../types";
import * as JSONC from "jsonc-parser";
import type { Node } from "jsonc-parser";

// See https://tools.ietf.org/html/rfc6901
function unescapeJsonPointerToken(token: string) {
	return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function parseJsonPointer(pointer: string): string[] {
	if (pointer === "") {
		return [];
	}
	if (pointer.charAt(0) !== "/") {
		throw new Error(`Invalid JSON pointer: ${pointer}`);
	}
	return pointer.substring(1).split("/").map(unescapeJsonPointerToken);
}

export class JsoncParser implements IParser {
  private getLineAndCharacter(text: string, offset: number): { line: number, character: number } {
    let line = 1;
    let character = 1;
    for (let i = 0; i < offset; i++) {
      if (text[i] === '\n') {
        line++;
        character = 1;
      } else {
        character++;
      }
    }
    return { line, character };
  }

  parse(jsonString: string): ParsedDocument {
    const errors: JSONC.ParseError[] = [];
    const root: Node | undefined = JSONC.parseTree(jsonString, errors);

    if (!root) {
      // Handle case where parsing returns nothing (e.g., empty string)
      return {
        data: null,
        getNodeLocation: () => ({ line: 0, column: 0, position: 0 }),
      };
    }

    const data: JsonValue = JSONC.getNodeValue(root);

    return {
      data,
      getNodeLocation: (path: string) => {
        const pathSegments = parseJsonPointer(path);
        const node = JSONC.findNodeAtLocation(root, pathSegments);
        if (node) {
          const { offset } = node;
          const { line, character } = this.getLineAndCharacter(jsonString, offset);
          return {
            line,
            column: character,
            position: offset,
          };
        }
        return { line: 0, column: 0, position: 0 };
      },
    };
  }
}
