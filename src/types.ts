import { Breakpoint, FunctionBreakpoint, SourceBreakpoint, type Position, type Range } from "vscode";

export interface JsonUri {
	path: string;
}

export interface JsonPosition {
	line: number;
	character: number;
}

export type JsonRange = [JsonPosition, JsonPosition];

export interface JsonLocation {
	uri: JsonUri;
	range: JsonRange
}

//FIXME: May be incorrect to extends Breakpoint here -- or maybe should do it as class...
export interface JsonBreakpoint extends Breakpoint {
	// SourceBreakpoint or FunctionBreakpoint data
	location?: JsonLocation;
	functionName?: string;
}

export interface BranchBreakpoints {
	version: string;
	branch: Branch[]
}

export type VSCodeBreakpoint = SourceBreakpoint | FunctionBreakpoint | Breakpoint;
//FIXME: This should probably just be SourceBreakpoint | FunctionBreakpoint

export type Branch = {
	name: string;
	breakpoints: JsonBreakpoint[];
};

export function toStringPosition(position: JsonPosition): string {
	return `(${position.line}, ${position.character})`;
}

export function toStringRange(range: JsonRange): string {
	return `[${toStringPosition(range[0])}, ${toStringPosition(range[1])}]`;
}

export function toJsonLineChar(lineChar: Position): JsonPosition {
	return { line: lineChar.line, character: lineChar.character };
}

export function toJsonRange(range: Range): JsonRange {
	return [toJsonLineChar(range.start), toJsonLineChar(range.end)];
}

export function isSourceBreakpoint(breakpoint: VSCodeBreakpoint): breakpoint is SourceBreakpoint {
	//FIXME: Should use instanceof SourceBreakpoint
	return (breakpoint as SourceBreakpoint).location !== undefined;
}

export function isFunctionBreakpoint(breakpoint: VSCodeBreakpoint): breakpoint is FunctionBreakpoint {
	//FIXME: Should use instanceof FunctionBreakpoint
	return (breakpoint as FunctionBreakpoint).functionName !== undefined;
}

export function areLineCharsEqual(lineChar1: JsonPosition, lineChar2: JsonPosition): boolean {
	return lineChar1.line === lineChar2.line && lineChar1.character === lineChar2.character;
}

export function areRangesEqual(range1: JsonRange, range2: JsonRange): boolean {
	return areLineCharsEqual(range1[0], range2[0]) && areLineCharsEqual(range1[1], range2[1]);
}

export function areBreakpointsEqual(breakpoint1: VSCodeBreakpoint, breakpoint2: VSCodeBreakpoint): boolean {
	if (isSourceBreakpoint(breakpoint1) && isSourceBreakpoint(breakpoint2)) {
		// FIXME: Maybe should use toString on uri not path
		if (breakpoint1.location.uri.path !== breakpoint2.location.uri.path) {
			return false;
		}
		if (breakpoint1 instanceof SourceBreakpoint && breakpoint2 instanceof SourceBreakpoint) {
			return breakpoint1.location.range.isEqual(breakpoint2.location.range);
		} else {
			console.error(`Unexpected breakpoint types: ${breakpoint1} and ${breakpoint2}`);
			const range1 = toJsonRange(breakpoint1.location.range);
			const range2 = toJsonRange(breakpoint2.location.range);
			return areRangesEqual(range1, range2);
		}
		
		
	} else if (isFunctionBreakpoint(breakpoint1) && isFunctionBreakpoint(breakpoint2)) {
		return breakpoint1.functionName === breakpoint2.functionName;
	}
	return false;
}
