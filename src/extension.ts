import * as fs from 'fs';
import { Breakpoint, BreakpointsChangeEvent, commands, ExtensionContext, FunctionBreakpoint, Location, OutputChannel, Position, Range, SourceBreakpoint, Uri, debug as vscodeDebug, window, workspace } from 'vscode';
import { areBreakpointsEqual, Branch, BranchBreakpoints, JsonBreakpoint, toStringRange } from './types';

const breakpointMapKeyName = 'breakpointMap';
const configurationSection = 'branchBreakpoints';
const traceConfiguration = 'trace';

let outputChannel: OutputChannel | undefined;

export function activate(context: ExtensionContext) {
	createOutputChannel(workspace.getConfiguration(configurationSection).get(traceConfiguration));
	trace('Extension activated');

	let branchBreakpoints: BranchBreakpoints;
	let recreated = false;
	[branchBreakpoints, recreated] = getWorkspaceBreakpoints(context);
	trace(`Loaded breakpoints: ${JSON.stringify(branchBreakpoints)}`);

	// TODO: Fix headFilename when workspace is `undefined`.
	// TODO: Support workspaces.
	const workspaceFolders = workspace.workspaceFolders;
	const headFilename = workspaceFolders && workspaceFolders.length === 1 ? `${workspaceFolders[0].uri.fsPath}/.git/HEAD` : undefined;
	let isBranchLocked = false;

	// Default head to no name for folders not using git.
	let head = '__noBranchName';
	if (headFilename && fs.existsSync(headFilename)) {
		head = getHead(headFilename);

		// TODO: Check out vscode fs watch instead.
		fs.watch(headFilename, () => {
			const newHead = getHead(headFilename);
			if (newHead === head) {
				trace(`Head not changed: ${head}`);
				return;
			}
			head = newHead;
			trace(`Using head: ${head}`);

			setBreakpoints();
		});
	}
	trace(`Using head: ${head}`);
	if (recreated) {
		setBreakpoints();
		context.workspaceState.update(breakpointMapKeyName, branchBreakpoints);
		trace(`Branch breakpoints recreated: ${JSON.stringify(branchBreakpoints)}`);
	}

	const printMapCommand = commands.registerCommand('branchBreakpoints.printMap', () => {
		trace(`branchBreakpoints: ${JSON.stringify(branchBreakpoints)}`);
	});
	const clearMapCommand = commands.registerCommand('branchBreakpoints.clearMap', () => {
		branchBreakpoints = clearBranchBreakpoints(context, branchBreakpoints);
	});

	context.subscriptions.push(printMapCommand, clearMapCommand);

	// TODO: Sometimes when vscode loads it triggers this event, saving the previously existing breakpoints.
	// affects when branches are changed with vscode closed.
	vscodeDebug.onDidChangeBreakpoints(e => {
		const update = getUpdatedBreakpoints(e, isBranchLocked, branchBreakpoints, head);
		if (update) {
			branchBreakpoints = update;
			context.workspaceState.update(breakpointMapKeyName, branchBreakpoints);
			trace(`Branch breakpoints updated: ${JSON.stringify(branchBreakpoints)}`);
		}

	});
	workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration(configurationSection)) {
			const isTraceEnabled = workspace.getConfiguration(configurationSection).get<boolean>(traceConfiguration);
			if (isTraceEnabled) {
				createOutputChannel(isTraceEnabled);
			} else {
				outputChannel?.dispose();
				outputChannel = undefined;
			}
			trace(`Configuration changed: isTraceEnabled=${isTraceEnabled}`);
		}
	});

	function setBreakpoints() {
		// Branch needs to get locked and unlocked as it will trigger multiple times the
		// onDidChangeBreakpoints event.
		try {
			isBranchLocked = true;

			const curBreakpoints = vscodeDebug.breakpoints;

			const branchBreakpoint = branchBreakpoints.branch.find(x => x.name === head);
			const jsonBreakpoints = branchBreakpoint?.breakpoints;

			if (jsonBreakpoints && jsonBreakpoints.length !== 0) {
				// Make sure all breakpoints from json are instantiated.
				const newBreakpoints = jsonBreakpoints.map(getBreakpoint);

				// Figure out which breakpoints need to be added and removed.
				const toRemove = new Array<Breakpoint>();
				for (const breakpoint of curBreakpoints) {
					if (!newBreakpoints.find(x => areBreakpointsEqual(breakpoint, x))) {
						toRemove.push(breakpoint);
					}
				}
				const toAdd = new Array<Breakpoint>();
				for (const breakpoint of newBreakpoints) {
					if (!curBreakpoints.find(x => areBreakpointsEqual(breakpoint, x))) {
						toAdd.push(breakpoint);
					}
				}
				// Add new breakpoints
				vscodeDebug.addBreakpoints(toAdd);
				// Remove old breakpoints
				vscodeDebug.removeBreakpoints(toRemove);
				//FIXME: trace number of unchanged breakpoints

				// Remove all breakpoints to then add only the saved ones.
				/*trace(`Remove breakpoints: ${JSON.stringify(curBreakpoints)}`);
				vscodeDebug.removeBreakpoints(curBreakpoints);
				vscodeDebug.addBreakpoints(newBreakpoints);
				trace(`Set breakpoints: ${JSON.stringify(newBreakpoints)}`);*/
			} else {
				trace(`No breakpoints set for ${head}`);
			}
		} finally {
			isBranchLocked = false;
		}
	}
}

export function deactivate() { }

function clearBranchBreakpoints(context: ExtensionContext, branchBreakpoints: BranchBreakpoints): BranchBreakpoints {
	branchBreakpoints = getInitialBranchBreakpoints(context);
	context.workspaceState.update(breakpointMapKeyName, undefined);

	trace(`Map cleared`);

	return branchBreakpoints;
}

function getInitialBranchBreakpoints(context: ExtensionContext): BranchBreakpoints {
	return {
		version: context.extension.packageJSON.version,
		branch: []
	};
}

function createOutputChannel(isTraceEnabled: boolean | undefined): void {
	if (isTraceEnabled) {
		outputChannel = outputChannel || window.createOutputChannel('Branch Breakpoints');
	}
}

function trace(value: string) {
	const dateOptions = [{ year: 'numeric' }, { month: '2-digit' }, { day: '2-digit' }];
	const timeOptions = [{ hour: '2-digit', hour12: false }, { minute: '2-digit' }, { second: '2-digit' }];

	const date = new Date();
	// @ts-ignore
	const dateFormatted = dateOptions.map((option) => new Intl.DateTimeFormat('en', option).format(date)).join('-');
	// @ts-ignore
	const timeFormatted = timeOptions.map((option) => new Intl.DateTimeFormat('en', option).format(date)).join(':');
	// @ts-ignore
	const millisecondFormatted = new Intl.DateTimeFormat('en', { fractionalSecondDigits: 3 }).format(date);

	const message = `[${dateFormatted} ${timeFormatted}.${millisecondFormatted}] ${value}`;
	if (outputChannel) {
		outputChannel.appendLine(message);
	} else {
		console.log(message);
	}
}

function getUpdatedBreakpoints(e: BreakpointsChangeEvent, isBranchLocked: boolean, branchBreakpoints: BranchBreakpoints, head: string): BranchBreakpoints | undefined {
	// If a branch is active, don't perform any operation
	if (isBranchLocked) {
		return;
	}

	const index = branchBreakpoints.branch.findIndex(x => x.name === head);

	const branch: Branch = index !== -1
		? branchBreakpoints.branch[index]
		: { name: head, breakpoints: [] };

	for (const breakpoint of e.added) {
		// Add the new breakpoint only if they don't exists yet.
		const existinBreakpoint = branch.breakpoints.find(x => areBreakpointsEqual(breakpoint, x));
		if (!existinBreakpoint) {
			branch.breakpoints.push(breakpoint);

			trace(`Added new breakpoint: ${JSON.stringify(breakpoint)}`);
		}
	}

	for (const breakpoint of e.changed) {
		const index = branch.breakpoints.findIndex(x => areBreakpointsEqual(x, breakpoint));
		branch.breakpoints.splice(index, 1);
		branch.breakpoints = [
			...branch.breakpoints.slice(0, index),
			breakpoint,
			...branch.breakpoints.slice(index + 1, branch.breakpoints.length)];

		trace(`Changed breakpoint index: ${index}`);
	}

	for (const breakpoint of e.removed) {
		const index = branch.breakpoints.findIndex(x => areBreakpointsEqual(x, breakpoint));
		branch.breakpoints.splice(index, 1);

		trace(`Removed breakpoint index: ${index}`);
	}

	const updatedBranches = [...branchBreakpoints.branch];
	if (index === -1) {
		updatedBranches.push(branch);
	} else {
		updatedBranches[index] = branch;
	}

	return {
		version: branchBreakpoints.version,
		branch: updatedBranches
	};
}

function getBreakpoint(breakpoint: JsonBreakpoint): Breakpoint {
	if (breakpoint instanceof SourceBreakpoint || breakpoint instanceof FunctionBreakpoint) {
		trace('Breakpoint already instantiated.');
		return breakpoint;
	}

	trace('Instantiate new breakpoint.');

	const { enabled, condition, functionName, hitCondition, location, logMessage } = breakpoint;

	// Instantiate the breakpoint.
	if (location) {
		const uri = Uri.parse(location.uri.path);

		const start = new Position(location.range[0].line, location.range[0].character);
		const end = new Position(location.range[1].line, location.range[1].character);
		const range = new Range(start, end);

		const locationInstance = new Location(uri, range);

		return new SourceBreakpoint(locationInstance, enabled, condition, hitCondition, logMessage);
	} else if (functionName) {
		return new FunctionBreakpoint(functionName, enabled, condition, hitCondition, logMessage);
	} else {
		throw new Error('location or functionName has not been defined on the breakpoint.');
	}
}

function getHead(headFilename: string): string {
	return fs.readFileSync(headFilename).toString();
}

function getWorkspaceBreakpoints(context: ExtensionContext): [BranchBreakpoints, boolean] {
	let branchBreakpoints: BranchBreakpoints = context.workspaceState.get(breakpointMapKeyName) ?? getInitialBranchBreakpoints(context);
	if (!branchBreakpoints.version) {
		const newVersion = '0.0.2'; // Version should match the "next" extension version.
		branchBreakpoints = clearBranchBreakpoints(context, branchBreakpoints);
		branchBreakpoints.version = newVersion;

		trace(`Updated to version: ${newVersion}`);
	}
	let recreated = false;
	for (const branch of branchBreakpoints.branch) {
		const branchName = branch.name.trim();
		try {
			const breakpoints = branch.breakpoints;
			type DuplicateBreakpoints = { breakpoint: JsonBreakpoint, count: number };
			const locationPathMap = new Map<string, Map<string, DuplicateBreakpoints>>();
			const functionNameMap = new Map<string, Array<JsonBreakpoint>>();
			for (const breakpoint of breakpoints) {
				const loc = breakpoint.location;
				const func = breakpoint.functionName;
				if (loc != null && func != null) {
					trace(`Unexpected location and function both set!`);
				} else if (loc != null) {
					// FIXME: Maybe should use toString on uri not path
					const path = loc.uri.path;
					const range = loc.range;
					const rangeStr = toStringRange(range);
					let rangeMap = locationPathMap.get(path);
					if (rangeMap == null) {
						rangeMap = new Map<string, DuplicateBreakpoints>();
						locationPathMap.set(path, rangeMap);
					}
					let duplicateBreakpoints = rangeMap.get(rangeStr);
					if (duplicateBreakpoints == null) {
						duplicateBreakpoints = { breakpoint, count: 1 };
					} else {
						duplicateBreakpoints = { breakpoint, count: duplicateBreakpoints.count + 1 };
					}
					rangeMap.set(rangeStr, duplicateBreakpoints);
				} else if (func != null) {
					const foundArr = functionNameMap.get(func);
					if (foundArr == null) {
						functionNameMap.set(func, [breakpoint]);
					} else {
						foundArr.push(breakpoint);
					}
				}
			}
			trace(`[${branchName}]: Found ${locationPathMap.size} locations and ${functionNameMap.size} functions.`);
			let needsRecreate = false;
			for (const [path, rangeMap] of locationPathMap) {
				for(const [rangeStr, duplicateBreakpoints] of rangeMap) {
					if (duplicateBreakpoints.count > 1) {
						trace(`[${branchName}]: Found ${duplicateBreakpoints.count} location breakpoints for ${path} at ${rangeStr}.`);
						needsRecreate = true;
					}
				}
			}
			for (const [func, value] of functionNameMap) {
				if (value.length > 1) {
					trace(`[${branchName}]: Found ${value.length} function breakpoints for ${func}.`);
					needsRecreate = true;
				}
			}
			if (needsRecreate) {
				const newBreakpoints = new Array<Breakpoint>();
				for (const [path, rangeMap] of locationPathMap) {
					for (const [rangeStr, duplicateBreakpoints] of rangeMap) {
						newBreakpoints.push(duplicateBreakpoints.breakpoint);
					}
				}
				for (const [func, funcBreakpoints] of functionNameMap) {
					newBreakpoints.push(funcBreakpoints[0]);
				}	
				branch.breakpoints = newBreakpoints;
				recreated = true;
				trace(`[${branchName}]: Recreated breakpoints; reduced from ${breakpoints.length} to ${newBreakpoints.length}.`);
			}

		} catch (e) {
			trace(`Failed to check breakpoints for branch: ${branchName}, ${e}`);
		}
	}

	return [branchBreakpoints, recreated];
}