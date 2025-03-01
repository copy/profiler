/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// @flow

import {
  encodeUintArrayForUrlComponent,
  decodeUintArrayFromUrlComponent,
} from '../utils/uintarray-encoding';
import {
  toValidImplementationFilter,
  getCallNodeIndexFromPath,
  updateThreadStacks,
  getMapStackUpdater,
} from './profile-data';
import { timeCode } from '../utils/time-code';
import { assertExhaustiveCheck, convertToTransformType } from '../utils/flow';
import { CallTree } from '../profile-logic/call-tree';
import {
  shallowCloneFrameTable,
  shallowCloneFuncTable,
  getEmptyStackTable,
} from './data-structures';
import { getFunctionName } from './function-info';

import type {
  Thread,
  FuncTable,
  IndexIntoCategoryList,
  IndexIntoFuncTable,
  IndexIntoStackTable,
  IndexIntoResourceTable,
  CallNodePath,
  CallNodeAndCategoryPath,
  CallNodeTable,
  StackType,
  ImplementationFilter,
  Transform,
  TransformType,
  TransformStack,
} from 'firefox-profiler/types';

/**
 * This file contains the functions and logic for working with and applying transforms
 * to profile data.
 */

// Create mappings from a transform name, to a url-friendly short name.
const TRANSFORM_TO_SHORT_KEY: { [TransformType]: string } = {};
const SHORT_KEY_TO_TRANSFORM: { [string]: TransformType } = {};
[
  'focus-subtree',
  'focus-function',
  'merge-call-node',
  'merge-function',
  'drop-function',
  'collapse-resource',
  'collapse-direct-recursion',
  'collapse-function-subtree',
].forEach((transform: TransformType) => {
  // This is kind of an awkward switch, but it ensures we've exhaustively checked that
  // we have a mapping for every transform.
  let shortKey;
  switch (transform) {
    case 'focus-subtree':
      shortKey = 'f';
      break;
    case 'focus-function':
      shortKey = 'ff';
      break;
    case 'merge-call-node':
      shortKey = 'mcn';
      break;
    case 'merge-function':
      shortKey = 'mf';
      break;
    case 'drop-function':
      shortKey = 'df';
      break;
    case 'collapse-resource':
      shortKey = 'cr';
      break;
    case 'collapse-direct-recursion':
      shortKey = 'rec';
      break;
    case 'collapse-function-subtree':
      shortKey = 'cfs';
      break;
    default: {
      throw assertExhaustiveCheck(transform);
    }
  }
  TRANSFORM_TO_SHORT_KEY[transform] = shortKey;
  SHORT_KEY_TO_TRANSFORM[shortKey] = transform;
});

/**
 * Map each transform key into a short representation.
 */

/**
 * Parses the transform stack that is applied to the selected thread,
 * or to the set of selected threads.
 * Every transform is separated by the "~" character.
 * Each transform is made up of a tuple separated by "-"
 * The first value in the tuple is a short key of the transform type.
 *
 * e.g "f-js-xFFpUMl-i" or "f-cpp-0KV4KV5KV61KV7KV8K"
 */
export function parseTransforms(transformString: string): TransformStack {
  if (!transformString) {
    return [];
  }
  const transforms = [];

  transformString.split('~').forEach((s) => {
    const tuple = s.split('-');
    const shortKey = tuple[0];
    const type = convertToTransformType(SHORT_KEY_TO_TRANSFORM[shortKey]);
    if (type === null) {
      console.error('Unrecognized transform was passed to the URL.', shortKey);
      return;
    }
    // This switch breaks down each transform into the minimum amount of data needed
    // to represent it in the URL. Each transform has slightly different requirements
    // as defined in src/types/transforms.js.
    switch (type) {
      case 'collapse-resource': {
        // e.g. "cr-js-325-8"
        const [, implementation, resourceIndexRaw, collapsedFuncIndexRaw] =
          tuple;
        const resourceIndex = parseInt(resourceIndexRaw, 10);
        const collapsedFuncIndex = parseInt(collapsedFuncIndexRaw, 10);
        if (isNaN(resourceIndex) || isNaN(collapsedFuncIndex)) {
          break;
        }
        if (resourceIndex >= 0) {
          transforms.push({
            type,
            resourceIndex,
            collapsedFuncIndex,
            implementation: toValidImplementationFilter(implementation),
          });
        }

        break;
      }
      case 'collapse-direct-recursion': {
        // e.g. "rec-js-325"
        const [, implementation, funcIndexRaw] = tuple;
        const funcIndex = parseInt(funcIndexRaw, 10);
        if (isNaN(funcIndex) || funcIndex < 0) {
          break;
        }
        transforms.push({
          type,
          funcIndex,
          implementation: toValidImplementationFilter(implementation),
        });
        break;
      }
      case 'merge-function':
      case 'focus-function':
      case 'drop-function':
      case 'collapse-function-subtree': {
        // e.g. "mf-325"
        const [, funcIndexRaw] = tuple;
        const funcIndex = parseInt(funcIndexRaw, 10);
        // Validate that the funcIndex makes sense.
        if (!isNaN(funcIndex) && funcIndex >= 0) {
          switch (type) {
            case 'merge-function':
              transforms.push({
                type: 'merge-function',
                funcIndex,
              });
              break;
            case 'focus-function':
              transforms.push({
                type: 'focus-function',
                funcIndex,
              });
              break;
            case 'drop-function':
              transforms.push({
                type: 'drop-function',
                funcIndex,
              });
              break;
            case 'collapse-function-subtree':
              transforms.push({
                type: 'collapse-function-subtree',
                funcIndex,
              });
              break;
            default:
              throw new Error('Unmatched transform.');
          }
        }
        break;
      }
      case 'focus-subtree':
      case 'merge-call-node': {
        // e.g. "f-js-xFFpUMl-i" or "f-cpp-0KV4KV5KV61KV7KV8K"
        const [, implementationRaw, serializedCallNodePath, invertedRaw] =
          tuple;
        const implementation = toValidImplementationFilter(implementationRaw);
        const callNodePath = decodeUintArrayFromUrlComponent(
          serializedCallNodePath
        );
        const inverted = Boolean(invertedRaw);
        // Flow requires a switch because it can't deduce the type string correctly.
        switch (type) {
          case 'focus-subtree':
            transforms.push({
              type: 'focus-subtree',
              implementation,
              callNodePath,
              inverted,
            });
            break;
          case 'merge-call-node':
            transforms.push({
              type: 'merge-call-node',
              implementation,
              callNodePath,
            });
            break;
          default:
            throw new Error('Unmatched transform.');
        }

        break;
      }
      default:
        throw assertExhaustiveCheck(type);
    }
  });
  return transforms;
}

/**
 * Each transform in the stack is separated by a "~".
 */
export function stringifyTransforms(transformStack: TransformStack): string {
  return transformStack
    .map((transform) => {
      const shortKey = TRANSFORM_TO_SHORT_KEY[transform.type];
      if (!shortKey) {
        throw new Error(
          'Expected to be able to convert a transform into its short key.'
        );
      }
      // This switch breaks down each transform into shared groups of what data
      // they need, as defined in src/types/transforms.js. For instance some transforms
      // need only a funcIndex, while some care about the current implemention, or
      // other pieces of data.
      switch (transform.type) {
        case 'merge-function':
        case 'drop-function':
        case 'collapse-function-subtree':
        case 'focus-function':
          return `${shortKey}-${transform.funcIndex}`;
        case 'collapse-resource':
          return `${shortKey}-${transform.implementation}-${transform.resourceIndex}-${transform.collapsedFuncIndex}`;
        case 'collapse-direct-recursion':
          return `${shortKey}-${transform.implementation}-${transform.funcIndex}`;
        case 'focus-subtree':
        case 'merge-call-node': {
          let string = [
            shortKey,
            transform.implementation,
            encodeUintArrayForUrlComponent(transform.callNodePath),
          ].join('-');
          if (transform.inverted) {
            string += '-i';
          }
          return string;
        }
        default:
          throw assertExhaustiveCheck(transform);
      }
    })
    .join('~');
}

export type TransformLabeL10nIds = {|
  +l10nId: string,
  +item: string,
|};

/**
 * Gets all applied transforms and returns their labels as l10n Ids with the
 * items associated to them. The `item`s can be a resource, function, or thread
 * name. They are being passed in the `Localized` component to create the
 * transform strings as desired.
 */
export function getTransformLabelL10nIds(
  thread: Thread,
  threadName: string,
  transforms: Transform[]
): Array<TransformLabeL10nIds> {
  const { funcTable, libs, stringTable, resourceTable } = thread;
  const labels: TransformLabeL10nIds[] = transforms.map((transform) => {
    // Lookup library information.
    if (transform.type === 'collapse-resource') {
      const libIndex = resourceTable.lib[transform.resourceIndex];
      let resourceName;
      if (libIndex === undefined || libIndex === null || libIndex === -1) {
        const nameIndex = resourceTable.name[transform.resourceIndex];
        if (nameIndex === -1) {
          throw new Error('Attempting to collapse a resource without a name');
        }
        resourceName = stringTable.getString(nameIndex);
      } else {
        resourceName = libs[libIndex].name;
      }
      return {
        l10nId: 'TransformNavigator--collapse-resource',
        item: resourceName,
      };
    }

    // Lookup function name.
    let funcIndex;
    switch (transform.type) {
      case 'focus-subtree':
      case 'merge-call-node':
        funcIndex = transform.callNodePath[transform.callNodePath.length - 1];
        break;
      case 'focus-function':
      case 'merge-function':
      case 'drop-function':
      case 'collapse-direct-recursion':
      case 'collapse-function-subtree':
        funcIndex = transform.funcIndex;
        break;
      default:
        throw assertExhaustiveCheck(transform);
    }
    const nameIndex = funcTable.name[funcIndex];
    const funcName = getFunctionName(stringTable.getString(nameIndex));

    switch (transform.type) {
      case 'focus-subtree':
        return { l10nId: 'TransformNavigator--focus-subtree', item: funcName };
      case 'focus-function':
        return { l10nId: 'TransformNavigator--focus-function', item: funcName };
      case 'merge-call-node':
        return {
          l10nId: 'TransformNavigator--merge-call-node',
          item: funcName,
        };
      case 'merge-function':
        return { l10nId: 'TransformNavigator--merge-function', item: funcName };
      case 'drop-function':
        return { l10nId: 'TransformNavigator--drop-function', item: funcName };
      case 'collapse-direct-recursion':
        return {
          l10nId: 'TransformNavigator--collapse-direct-recursion',
          item: funcName,
        };
      case 'collapse-function-subtree':
        return {
          l10nId: 'TransformNavigator--collapse-function-subtree',
          item: funcName,
        };
      default:
        throw assertExhaustiveCheck(transform);
    }
  });
  labels.unshift({
    l10nId: 'TransformNavigator--complete',
    item: threadName,
  });
  return labels;
}

export function applyTransformToCallNodePath(
  callNodePath: CallNodePath,
  transform: Transform,
  transformedThread: Thread
): CallNodePath {
  switch (transform.type) {
    case 'focus-subtree':
      return _removePrefixPathFromCallNodePath(
        transform.callNodePath,
        callNodePath
      );
    case 'focus-function':
      return _startCallNodePathWithFunction(transform.funcIndex, callNodePath);
    case 'merge-call-node':
      return _mergeNodeInCallNodePath(transform.callNodePath, callNodePath);
    case 'merge-function':
      return _mergeFunctionInCallNodePath(transform.funcIndex, callNodePath);
    case 'drop-function':
      return _dropFunctionInCallNodePath(transform.funcIndex, callNodePath);
    case 'collapse-resource':
      return _collapseResourceInCallNodePath(
        transform.resourceIndex,
        transform.collapsedFuncIndex,
        transformedThread.funcTable,
        callNodePath
      );
    case 'collapse-direct-recursion':
      return _collapseDirectRecursionInCallNodePath(
        transform.funcIndex,
        callNodePath
      );
    case 'collapse-function-subtree':
      return _collapseFunctionSubtreeInCallNodePath(
        transform.funcIndex,
        callNodePath
      );
    default:
      throw assertExhaustiveCheck(transform);
  }
}

function _removePrefixPathFromCallNodePath(
  prefixPath: CallNodePath,
  callNodePath: CallNodePath
): CallNodePath {
  return _callNodePathHasPrefixPath(prefixPath, callNodePath)
    ? callNodePath.slice(prefixPath.length - 1)
    : [];
}

function _startCallNodePathWithFunction(
  funcIndex: IndexIntoFuncTable,
  callNodePath: CallNodePath
): CallNodePath {
  const startIndex = callNodePath.indexOf(funcIndex);
  return startIndex === -1 ? [] : callNodePath.slice(startIndex);
}

function _mergeNodeInCallNodePath(
  prefixPath: CallNodePath,
  callNodePath: CallNodePath
): CallNodePath {
  return _callNodePathHasPrefixPath(prefixPath, callNodePath)
    ? callNodePath.filter((_, i) => i !== prefixPath.length - 1)
    : callNodePath;
}

function _mergeFunctionInCallNodePath(
  funcIndex: IndexIntoFuncTable,
  callNodePath: CallNodePath
): CallNodePath {
  return callNodePath.filter((nodeFunc) => nodeFunc !== funcIndex);
}

function _dropFunctionInCallNodePath(
  funcIndex: IndexIntoFuncTable,
  callNodePath: CallNodePath
): CallNodePath {
  // If the CallNodePath contains the function, return an empty path.
  return callNodePath.includes(funcIndex) ? [] : callNodePath;
}

function _collapseResourceInCallNodePath(
  resourceIndex: IndexIntoResourceTable,
  collapsedFuncIndex: IndexIntoFuncTable,
  funcTable: FuncTable,
  callNodePath: CallNodePath
) {
  return (
    callNodePath
      // Map any collapsed functions into the collapsedFuncIndex
      .map((pathFuncIndex) => {
        return funcTable.resource[pathFuncIndex] === resourceIndex
          ? collapsedFuncIndex
          : pathFuncIndex;
      })
      // De-duplicate contiguous collapsed funcs
      .filter(
        (pathFuncIndex, pathIndex, path) =>
          // This function doesn't match the previous one, so keep it.
          pathFuncIndex !== path[pathIndex - 1] ||
          // This function matched the previous, only keep it if doesn't match the
          // collapsed func.
          pathFuncIndex !== collapsedFuncIndex
      )
  );
}

function _collapseDirectRecursionInCallNodePath(
  funcIndex: IndexIntoFuncTable,
  callNodePath: CallNodePath
) {
  const newPath = [];
  let previousFunc;
  for (let i = 0; i < callNodePath.length; i++) {
    const pathFunc = callNodePath[i];
    if (pathFunc !== funcIndex || pathFunc !== previousFunc) {
      newPath.push(pathFunc);
    }
    previousFunc = pathFunc;
  }
  return newPath;
}

function _collapseFunctionSubtreeInCallNodePath(
  funcIndex: IndexIntoFuncTable,
  callNodePath: CallNodePath
) {
  const index = callNodePath.indexOf(funcIndex);
  return index === -1 ? callNodePath : callNodePath.slice(0, index + 1);
}

function _callNodePathHasPrefixPath(
  prefixPath: CallNodePath,
  callNodePath: CallNodePath
): boolean {
  return (
    prefixPath.length <= callNodePath.length &&
    prefixPath.every((prefixFunc, i) => prefixFunc === callNodePath[i])
  );
}

/**
 * Take a CallNodePath, and invert it given a CallTree. Note that if the CallTree
 * is itself inverted, you will get back the uninverted CallNodePath to the regular
 * CallTree.
 *
 * e.g:
 *   (invertedPath, invertedCallTree) => path
 *   (path, callTree) => invertedPath
 *
 * Call trees are sorted with the CallNodes with the heaviest total time as the first
 * entry. This function walks to the tip of the heaviest branches to find the leaf node,
 * then construct an inverted CallNodePath with the result. This gives a pretty decent
 * result, but it doesn't guarantee that it will select the heaviest CallNodePath for the
 * INVERTED call tree. This would require doing a round trip through the reducers or
 * some other mechanism in order to first calculate the next inverted call tree. This is
 * probably not worth it, so go ahead and use the uninverted call tree, as it's probably
 * good enough.
 */
export function invertCallNodePath(
  path: CallNodePath,
  callTree: CallTree,
  callNodeTable: CallNodeTable
): CallNodePath {
  let callNodeIndex = getCallNodeIndexFromPath(path, callNodeTable);
  if (callNodeIndex === null) {
    // No path was found, return an empty CallNodePath.
    return [];
  }
  let children = [callNodeIndex];
  const pathToLeaf = [];
  do {
    // Walk down the tree's depth to construct a path to the leaf node, this should
    // be the heaviest branch of the tree.
    callNodeIndex = children[0];
    pathToLeaf.push(callNodeIndex);
    children = callTree.getChildren(callNodeIndex);
  } while (children && children.length > 0);

  return (
    pathToLeaf
      // Map the CallNodeIndex to FuncIndex.
      .map((index) => callNodeTable.func[index])
      // Reverse it so that it's in the proper inverted order.
      .reverse()
  );
}

/**
 * Transform a thread's stacks to merge stacks that match the CallNodePath into
 * the calling stack. See `src/types/transforms.js` for more information about the
 * "merge-call-node" transform.
 */
export function mergeCallNode(
  thread: Thread,
  callNodePath: CallNodePath,
  implementation: ImplementationFilter
): Thread {
  return timeCode('mergeCallNode', () => {
    const { stackTable, frameTable } = thread;
    // Depth here is 0 indexed.
    const depthAtCallNodePathLeaf = callNodePath.length - 1;
    const oldStackToNewStack: Map<
      IndexIntoStackTable | null,
      IndexIntoStackTable | null
    > = new Map();
    // A root stack's prefix will be null. Maintain that relationship from old to new
    // stacks by mapping from null to null.
    oldStackToNewStack.set(null, null);
    const newStackTable = getEmptyStackTable();
    // Provide two arrays to efficiently cache values for the algorithm. This probably
    // could be refactored to use only one array here.
    const stackDepths = [];
    const stackMatches = [];
    const funcMatchesImplementation = FUNC_MATCHES[implementation];
    for (let stackIndex = 0; stackIndex < stackTable.length; stackIndex++) {
      const prefix = stackTable.prefix[stackIndex];
      const frameIndex = stackTable.frame[stackIndex];
      const category = stackTable.category[stackIndex];
      const subcategory = stackTable.subcategory[stackIndex];
      const funcIndex = frameTable.func[frameIndex];

      const doesPrefixMatch = prefix === null ? true : stackMatches[prefix];
      const prefixDepth = prefix === null ? -1 : stackDepths[prefix];
      const currentFuncOnPath = callNodePath[prefixDepth + 1];

      let doMerge = false;
      let stackDepth = prefixDepth;
      let doesMatchCallNodePath;
      if (doesPrefixMatch && stackDepth < depthAtCallNodePathLeaf) {
        // This stack's prefixes were in our CallNodePath.
        if (currentFuncOnPath === funcIndex) {
          // This stack's function matches too!
          doesMatchCallNodePath = true;
          if (stackDepth + 1 === depthAtCallNodePathLeaf) {
            // Holy cow, we found a match for our merge operation and can merge this stack.
            doMerge = true;
          } else {
            // Since we found a match, increase the stack depth. This should match
            // the depth of the implementation filtered stacks.
            stackDepth++;
          }
        } else if (!funcMatchesImplementation(thread, funcIndex)) {
          // This stack's function does not match the CallNodePath, however it's not part
          // of the CallNodePath's implementation filter. Go ahead and keep it.
          doesMatchCallNodePath = true;
        } else {
          // While all of the predecessors matched, this stack's function does not :(
          doesMatchCallNodePath = false;
        }
      } else {
        // This stack is not part of a matching branch of the tree.
        doesMatchCallNodePath = false;
      }
      stackMatches[stackIndex] = doesMatchCallNodePath;
      stackDepths[stackIndex] = stackDepth;

      // Map the oldStackToNewStack, and only push on the stacks that aren't merged.
      if (doMerge) {
        const newStackPrefix = oldStackToNewStack.get(prefix);
        oldStackToNewStack.set(
          stackIndex,
          newStackPrefix === undefined ? null : newStackPrefix
        );
      } else {
        const newStackIndex = newStackTable.length++;
        const newStackPrefix = oldStackToNewStack.get(prefix);
        newStackTable.prefix[newStackIndex] =
          newStackPrefix === undefined ? null : newStackPrefix;
        newStackTable.frame[newStackIndex] = frameIndex;
        newStackTable.category[newStackIndex] = category;
        newStackTable.subcategory[newStackIndex] = subcategory;
        oldStackToNewStack.set(stackIndex, newStackIndex);
      }
    }

    return updateThreadStacks(
      thread,
      newStackTable,
      getMapStackUpdater(oldStackToNewStack)
    );
  });
}

/**
 * Go through the StackTable and remove any stacks that are part of the given function.
 * This operation effectively merges the timing of the stacks into their callers.
 */
export function mergeFunction(
  thread: Thread,
  funcIndexToMerge: IndexIntoFuncTable
): Thread {
  const { stackTable, frameTable } = thread;
  const oldStackToNewStack: Map<
    IndexIntoStackTable | null,
    IndexIntoStackTable | null
  > = new Map();
  // A root stack's prefix will be null. Maintain that relationship from old to new
  // stacks by mapping from null to null.
  oldStackToNewStack.set(null, null);
  const newStackTable = getEmptyStackTable();

  for (let stackIndex = 0; stackIndex < stackTable.length; stackIndex++) {
    const prefix = stackTable.prefix[stackIndex];
    const frameIndex = stackTable.frame[stackIndex];
    const category = stackTable.category[stackIndex];
    const subcategory = stackTable.subcategory[stackIndex];
    const funcIndex = frameTable.func[frameIndex];

    if (funcIndex === funcIndexToMerge) {
      const newStackPrefix = oldStackToNewStack.get(prefix);
      oldStackToNewStack.set(
        stackIndex,
        newStackPrefix === undefined ? null : newStackPrefix
      );
    } else {
      const newStackIndex = newStackTable.length++;
      const newStackPrefix = oldStackToNewStack.get(prefix);
      newStackTable.prefix[newStackIndex] =
        newStackPrefix === undefined ? null : newStackPrefix;
      newStackTable.frame[newStackIndex] = frameIndex;
      newStackTable.category[newStackIndex] = category;
      newStackTable.subcategory[newStackIndex] = subcategory;
      oldStackToNewStack.set(stackIndex, newStackIndex);
    }
  }

  return updateThreadStacks(
    thread,
    newStackTable,
    getMapStackUpdater(oldStackToNewStack)
  );
}

/**
 * Drop any samples that contain the given function.
 */
export function dropFunction(
  thread: Thread,
  funcIndexToDrop: IndexIntoFuncTable
) {
  const { stackTable, frameTable } = thread;

  // Go through each stack, and label it as containing the function or not.
  const stackContainsFunc: Array<void | true> = [];
  for (let stackIndex = 0; stackIndex < stackTable.length; stackIndex++) {
    const prefix = stackTable.prefix[stackIndex];
    const frameIndex = stackTable.frame[stackIndex];
    const funcIndex = frameTable.func[frameIndex];
    if (
      // This is the function we want to remove.
      funcIndex === funcIndexToDrop ||
      // The parent of this stack contained the function.
      (prefix !== null && stackContainsFunc[prefix])
    ) {
      stackContainsFunc[stackIndex] = true;
    }
  }

  return updateThreadStacks(thread, stackTable, (stack) =>
    // Drop the stacks that contain that function.
    stack !== null && stackContainsFunc[stack] ? null : stack
  );
}

export function collapseResource(
  thread: Thread,
  resourceIndexToCollapse: IndexIntoResourceTable,
  implementation: ImplementationFilter,
  defaultCategory: IndexIntoCategoryList
): Thread {
  const { stackTable, funcTable, frameTable, resourceTable } = thread;
  const resourceNameIndex = resourceTable.name[resourceIndexToCollapse];
  const newFrameTable = shallowCloneFrameTable(frameTable);
  const newFuncTable = shallowCloneFuncTable(funcTable);
  const newStackTable = getEmptyStackTable();
  const oldStackToNewStack: Map<
    IndexIntoStackTable | null,
    IndexIntoStackTable | null
  > = new Map();
  const prefixStackToCollapsedStack: Map<
    IndexIntoStackTable | null, // prefix stack index
    IndexIntoStackTable | null // collapsed stack index
  > = new Map();
  const collapsedStacks: Set<IndexIntoStackTable | null> = new Set();
  const funcMatchesImplementation = FUNC_MATCHES[implementation];

  // A root stack's prefix will be null. Maintain that relationship from old to new
  // stacks by mapping from null to null.
  oldStackToNewStack.set(null, null);
  // A new func and frame will be created on the first stack that is found that includes
  // the given resource.
  let collapsedFrameIndex;
  let collapsedFuncIndex;

  for (let stackIndex = 0; stackIndex < stackTable.length; stackIndex++) {
    const prefix = stackTable.prefix[stackIndex];
    const frameIndex = stackTable.frame[stackIndex];
    const category = stackTable.category[stackIndex];
    const subcategory = stackTable.subcategory[stackIndex];
    const funcIndex = frameTable.func[frameIndex];
    const resourceIndex = funcTable.resource[funcIndex];
    const newStackPrefix = oldStackToNewStack.get(prefix);

    if (newStackPrefix === undefined) {
      throw new Error('newStackPrefix must not be undefined');
    }
    if (resourceIndex === resourceIndexToCollapse) {
      // The stack matches this resource.
      if (!collapsedStacks.has(newStackPrefix)) {
        // The prefix is not a collapsed stack. So this stack will not collapse into its
        // prefix stack. But it might collapse into a sibling stack, if there exists a
        // sibling with the same resource. Check if a collapsed stack with the same
        // prefix (i.e. a collapsed sibling) exists.

        const existingCollapsedStack = prefixStackToCollapsedStack.get(prefix);
        if (existingCollapsedStack === undefined) {
          // Create a new collapsed frame.

          // Compute the next indexes
          const newStackIndex = newStackTable.length++;
          collapsedStacks.add(newStackIndex);
          oldStackToNewStack.set(stackIndex, newStackIndex);
          prefixStackToCollapsedStack.set(prefix, newStackIndex);

          if (collapsedFrameIndex === undefined) {
            collapsedFrameIndex = newFrameTable.length++;
            collapsedFuncIndex = newFuncTable.length++;
            // Add the collapsed frame
            newFrameTable.address.push(frameTable.address[frameIndex]);
            newFrameTable.inlineDepth.push(frameTable.inlineDepth[frameIndex]);
            newFrameTable.category.push(frameTable.category[frameIndex]);
            newFrameTable.subcategory.push(frameTable.subcategory[frameIndex]);
            newFrameTable.func.push(collapsedFuncIndex);
            newFrameTable.nativeSymbol.push(
              frameTable.nativeSymbol[frameIndex]
            );
            newFrameTable.line.push(frameTable.line[frameIndex]);
            newFrameTable.column.push(frameTable.column[frameIndex]);
            newFrameTable.innerWindowID.push(
              frameTable.innerWindowID[frameIndex]
            );
            newFrameTable.implementation.push(
              frameTable.implementation[frameIndex]
            );
            newFrameTable.optimizations.push(
              frameTable.optimizations[frameIndex]
            );

            // Add the psuedo-func
            newFuncTable.isJS.push(funcTable.isJS[funcIndex]);
            newFuncTable.name.push(resourceNameIndex);
            newFuncTable.resource.push(funcTable.resource[funcIndex]);
            newFuncTable.fileName.push(funcTable.fileName[funcIndex]);
            newFuncTable.lineNumber.push(null);
            newFuncTable.columnNumber.push(null);
          }

          // Add the new stack.
          newStackTable.prefix.push(newStackPrefix);
          newStackTable.frame.push(collapsedFrameIndex);
          newStackTable.category.push(category);
          newStackTable.subcategory.push(subcategory);
        } else {
          // A collapsed stack at this level already exists, use that one.
          if (existingCollapsedStack === null) {
            throw new Error('existingCollapsedStack cannot be null');
          }
          oldStackToNewStack.set(stackIndex, existingCollapsedStack);
          if (newStackTable.category[existingCollapsedStack] !== category) {
            // Conflicting origin stack categories -> default category + subcategory.
            newStackTable.category[existingCollapsedStack] = defaultCategory;
            newStackTable.subcategory[existingCollapsedStack] = 0;
          } else if (
            newStackTable.subcategory[existingCollapsedStack] !== subcategory
          ) {
            // Conflicting origin stack subcategories -> "Other" subcategory.
            newStackTable.subcategory[existingCollapsedStack] = 0;
          }
        }
      } else {
        // The prefix was already collapsed, use that one.
        oldStackToNewStack.set(stackIndex, newStackPrefix);
      }
    } else {
      if (
        !funcMatchesImplementation(thread, funcIndex) &&
        newStackPrefix !== null
      ) {
        // This function doesn't match the implementation filter.
        const prefixFrame = newStackTable.frame[newStackPrefix];
        const prefixFunc = newFrameTable.func[prefixFrame];
        const prefixResource = newFuncTable.resource[prefixFunc];

        if (prefixResource === resourceIndexToCollapse) {
          // This stack's prefix did match the collapsed resource, map the stack
          // to the already collapsed stack and move on.
          oldStackToNewStack.set(stackIndex, newStackPrefix);
          continue;
        }
      }
      // This stack isn't part of the collapsed resource. Copy over the previous stack.
      const newStackIndex = newStackTable.length++;
      newStackTable.prefix.push(newStackPrefix);
      newStackTable.frame.push(frameIndex);
      newStackTable.category.push(category);
      newStackTable.subcategory.push(subcategory);
      oldStackToNewStack.set(stackIndex, newStackIndex);
    }
  }

  const newThread = {
    ...thread,
    frameTable: newFrameTable,
    funcTable: newFuncTable,
  };

  return updateThreadStacks(
    newThread,
    newStackTable,
    getMapStackUpdater(oldStackToNewStack)
  );
}

export function collapseDirectRecursion(
  thread: Thread,
  funcToCollapse: IndexIntoFuncTable,
  implementation: ImplementationFilter
): Thread {
  const { stackTable, frameTable } = thread;
  const oldStackToNewStack: Map<
    IndexIntoStackTable | null,
    IndexIntoStackTable | null
  > = new Map();
  // A root stack's prefix will be null. Maintain that relationship from old to new
  // stacks by mapping from null to null.
  oldStackToNewStack.set(null, null);
  const recursiveStacks = new Set();
  const newStackTable = getEmptyStackTable();
  const funcMatchesImplementation = FUNC_MATCHES[implementation];

  for (let stackIndex = 0; stackIndex < stackTable.length; stackIndex++) {
    const prefix = stackTable.prefix[stackIndex];
    const frameIndex = stackTable.frame[stackIndex];
    const category = stackTable.category[stackIndex];
    const subcategory = stackTable.subcategory[stackIndex];
    const funcIndex = frameTable.func[frameIndex];

    if (
      // The previous stacks were collapsed or matched the funcToCollapse, check to see
      // if this is a candidate for collapsing as well.
      recursiveStacks.has(prefix) &&
      // Either the function must match, or the implementation must be different.
      (funcToCollapse === funcIndex ||
        !funcMatchesImplementation(thread, funcIndex))
    ) {
      // Out of N consecutive stacks that match the function to collapse, only remove
      // stacks that are N > 1.
      const newPrefixStackIndex = oldStackToNewStack.get(prefix);
      if (newPrefixStackIndex === undefined) {
        throw new Error('newPrefixStackIndex cannot be undefined');
      }
      oldStackToNewStack.set(stackIndex, newPrefixStackIndex);
      recursiveStacks.add(stackIndex);
    } else {
      // Add a stack in two cases:
      //   1. It doesn't match the collapse requirements.
      //   2. It is the first instance of a stack to collapse, re-use the stack and frame
      //      information for the collapsed stack.
      const newStackIndex = newStackTable.length++;
      const newStackPrefix = oldStackToNewStack.get(prefix);
      if (newStackPrefix === undefined) {
        throw new Error(
          'The newStackPrefix must exist because prefix < stackIndex as the StackTable is ordered.'
        );
      }
      newStackTable.prefix[newStackIndex] = newStackPrefix;
      newStackTable.frame[newStackIndex] = frameIndex;
      newStackTable.category[newStackIndex] = category;
      newStackTable.subcategory[newStackIndex] = subcategory;
      oldStackToNewStack.set(stackIndex, newStackIndex);

      if (funcToCollapse === funcIndex) {
        recursiveStacks.add(stackIndex);
      }
    }
  }
  return updateThreadStacks(
    thread,
    newStackTable,
    getMapStackUpdater(oldStackToNewStack)
  );
}
const FUNC_MATCHES = {
  combined: (_thread: Thread, _funcIndex: IndexIntoFuncTable) => true,
  cpp: (thread: Thread, funcIndex: IndexIntoFuncTable): boolean => {
    const { funcTable, stringTable } = thread;
    // Return quickly if this is a JS frame.
    if (thread.funcTable.isJS[funcIndex]) {
      return false;
    }

    // Regular C++ functions are associated with a resource that describes the
    // shared library that these C++ functions were loaded from. Jitcode is not
    // loaded from shared libraries but instead generated at runtime, so Jitcode
    // frames are not associated with a shared library and thus have no resource
    const locationString = stringTable.getString(funcTable.name[funcIndex]);
    const isProbablyJitCode =
      funcTable.resource[funcIndex] === -1 && locationString.startsWith('0x');
    return !isProbablyJitCode;
  },
  js: (thread: Thread, funcIndex: IndexIntoFuncTable): boolean => {
    return (
      thread.funcTable.isJS[funcIndex] ||
      thread.funcTable.relevantForJS[funcIndex]
    );
  },
};

export function collapseFunctionSubtree(
  thread: Thread,
  funcToCollapse: IndexIntoFuncTable,
  defaultCategory: IndexIntoCategoryList
): Thread {
  const { stackTable, frameTable } = thread;
  const oldStackToNewStack: Map<
    IndexIntoStackTable | null,
    IndexIntoStackTable | null
  > = new Map();
  // A root stack's prefix will be null. Maintain that relationship from old to new
  // stacks by mapping from null to null.
  oldStackToNewStack.set(null, null);
  const collapsedStacks = new Set();
  const newStackTable = getEmptyStackTable();

  for (let stackIndex = 0; stackIndex < stackTable.length; stackIndex++) {
    const prefix = stackTable.prefix[stackIndex];
    if (
      // The previous stack was collapsed, this one is collapsed too.
      collapsedStacks.has(prefix)
    ) {
      // Only remember that this stack is collapsed.
      const newPrefixStackIndex = oldStackToNewStack.get(prefix);
      if (newPrefixStackIndex === undefined) {
        throw new Error('newPrefixStackIndex cannot be undefined');
      }
      // Many collapsed stacks will potentially all point to the first stack that used the
      // funcToCollapse, so newPrefixStackIndex will potentially be assigned to many
      // stacks. This is what actually "collapses" a stack.
      oldStackToNewStack.set(stackIndex, newPrefixStackIndex);
      collapsedStacks.add(stackIndex);

      // Fall back to the default category when stack categories conflict.
      if (newPrefixStackIndex !== null) {
        if (
          newStackTable.category[newPrefixStackIndex] !==
          stackTable.category[stackIndex]
        ) {
          newStackTable.category[newPrefixStackIndex] = defaultCategory;
          newStackTable.subcategory[newPrefixStackIndex] = 0;
        } else if (
          newStackTable.subcategory[newPrefixStackIndex] !==
          stackTable.subcategory[stackIndex]
        ) {
          newStackTable.subcategory[newPrefixStackIndex] = 0;
        }
      }
    } else {
      // Add this stack.
      const newStackIndex = newStackTable.length++;
      const newStackPrefix = oldStackToNewStack.get(prefix);
      if (newStackPrefix === undefined) {
        throw new Error(
          'The newStackPrefix must exist because prefix < stackIndex as the StackTable is ordered.'
        );
      }

      const frameIndex = stackTable.frame[stackIndex];
      const category = stackTable.category[stackIndex];
      const subcategory = stackTable.subcategory[stackIndex];
      newStackTable.prefix[newStackIndex] = newStackPrefix;
      newStackTable.frame[newStackIndex] = frameIndex;
      newStackTable.category[newStackIndex] = category;
      newStackTable.subcategory[newStackIndex] = subcategory;
      oldStackToNewStack.set(stackIndex, newStackIndex);

      // If this is the function to collapse, keep the stack, but note that its children
      // should be discarded.
      const funcIndex = frameTable.func[frameIndex];
      if (funcToCollapse === funcIndex) {
        collapsedStacks.add(stackIndex);
      }
    }
  }

  return updateThreadStacks(
    thread,
    newStackTable,
    getMapStackUpdater(oldStackToNewStack)
  );
}

/**
 * Filter thread to only contain stacks which start with a CallNodePath, and
 * only samples with those stacks. The new stacks' roots will be frames whose
 * func is the last element of the prefix CallNodePath.
 */
export function focusSubtree(
  thread: Thread,
  callNodePath: CallNodePath,
  implementation: ImplementationFilter
): Thread {
  return timeCode('focusSubtree', () => {
    const { stackTable, frameTable } = thread;
    const prefixDepth = callNodePath.length;
    const stackMatches = new Int32Array(stackTable.length);
    const funcMatchesImplementation = FUNC_MATCHES[implementation];
    const oldStackToNewStack: Map<
      IndexIntoStackTable | null,
      IndexIntoStackTable | null
    > = new Map();
    // A root stack's prefix will be null. Maintain that relationship from old to new
    // stacks by mapping from null to null.
    oldStackToNewStack.set(null, null);
    const newStackTable = getEmptyStackTable();
    for (let stackIndex = 0; stackIndex < stackTable.length; stackIndex++) {
      const prefix = stackTable.prefix[stackIndex];
      const prefixMatchesUpTo = prefix !== null ? stackMatches[prefix] : 0;
      let stackMatchesUpTo = -1;
      if (prefixMatchesUpTo !== -1) {
        const frame = stackTable.frame[stackIndex];
        const category = stackTable.category[stackIndex];
        const subcategory = stackTable.subcategory[stackIndex];
        if (prefixMatchesUpTo === prefixDepth) {
          stackMatchesUpTo = prefixDepth;
        } else {
          const funcIndex = frameTable.func[frame];
          if (funcIndex === callNodePath[prefixMatchesUpTo]) {
            stackMatchesUpTo = prefixMatchesUpTo + 1;
          } else if (!funcMatchesImplementation(thread, funcIndex)) {
            stackMatchesUpTo = prefixMatchesUpTo;
          }
        }
        if (stackMatchesUpTo === prefixDepth) {
          const newStackIndex = newStackTable.length++;
          const newStackPrefix = oldStackToNewStack.get(prefix);
          newStackTable.prefix[newStackIndex] = newStackPrefix ?? null;
          newStackTable.frame[newStackIndex] = frame;
          newStackTable.category[newStackIndex] = category;
          newStackTable.subcategory[newStackIndex] = subcategory;
          oldStackToNewStack.set(stackIndex, newStackIndex);
        }
      }
      stackMatches[stackIndex] = stackMatchesUpTo;
    }

    return updateThreadStacks(thread, newStackTable, (oldStack) => {
      if (oldStack === null || stackMatches[oldStack] !== prefixDepth) {
        return null;
      }
      const newStack = oldStackToNewStack.get(oldStack);
      if (newStack === undefined) {
        throw new Error(
          'Converting from the old stack to a new stack cannot be undefined'
        );
      }
      return newStack;
    });
  });
}

/**
 * Filter thread to only contain stacks which end with a CallNodePath, and
 * only samples with those stacks. The new stacks' leaf frames will be
 * frames whose func is the last element of the postfix func array.
 */
export function focusInvertedSubtree(
  thread: Thread,
  postfixCallNodePath: CallNodePath,
  implementation: ImplementationFilter
): Thread {
  return timeCode('focusInvertedSubtree', () => {
    const postfixDepth = postfixCallNodePath.length;
    const { stackTable, frameTable } = thread;
    const funcMatchesImplementation = FUNC_MATCHES[implementation];
    function convertStack(leaf) {
      let matchesUpToDepth = 0; // counted from the leaf
      for (let stack = leaf; stack !== null; stack = stackTable.prefix[stack]) {
        const frame = stackTable.frame[stack];
        const funcIndex = frameTable.func[frame];
        if (funcIndex === postfixCallNodePath[matchesUpToDepth]) {
          matchesUpToDepth++;
          if (matchesUpToDepth === postfixDepth) {
            return stack;
          }
        } else if (funcMatchesImplementation(thread, funcIndex)) {
          return null;
        }
      }
      return null;
    }

    const oldStackToNewStack = new Map();
    // A root stack's prefix will be null. Maintain that relationship from old to new
    // stacks by mapping from null to null.
    oldStackToNewStack.set(null, null);

    return updateThreadStacks(thread, stackTable, (stackIndex) => {
      let newStackIndex = oldStackToNewStack.get(stackIndex);
      if (newStackIndex === undefined) {
        newStackIndex = convertStack(stackIndex);
        oldStackToNewStack.set(stackIndex, newStackIndex);
      }
      return newStackIndex;
    });
  });
}

export function focusFunction(
  thread: Thread,
  funcIndexToFocus: IndexIntoFuncTable
): Thread {
  return timeCode('focusFunction', () => {
    const { stackTable, frameTable } = thread;
    const oldStackToNewStack: Map<
      IndexIntoStackTable | null,
      IndexIntoStackTable | null
    > = new Map();
    // A root stack's prefix will be null. Maintain that relationship from old to new
    // stacks by mapping from null to null.
    oldStackToNewStack.set(null, null);
    const newStackTable = getEmptyStackTable();

    for (let stackIndex = 0; stackIndex < stackTable.length; stackIndex++) {
      const prefix = stackTable.prefix[stackIndex];
      const frameIndex = stackTable.frame[stackIndex];
      const category = stackTable.category[stackIndex];
      const subcategory = stackTable.subcategory[stackIndex];
      const funcIndex = frameTable.func[frameIndex];
      const matchesFocusFunc = funcIndex === funcIndexToFocus;

      const newPrefix = oldStackToNewStack.get(prefix);
      if (newPrefix === undefined) {
        throw new Error('The prefix should not map to an undefined value');
      }

      if (newPrefix !== null || matchesFocusFunc) {
        const newStackIndex = newStackTable.length++;
        newStackTable.prefix[newStackIndex] = newPrefix;
        newStackTable.frame[newStackIndex] = frameIndex;
        newStackTable.category[newStackIndex] = category;
        newStackTable.subcategory[newStackIndex] = subcategory;
        oldStackToNewStack.set(stackIndex, newStackIndex);
      } else {
        oldStackToNewStack.set(stackIndex, null);
      }
    }

    return updateThreadStacks(
      thread,
      newStackTable,
      getMapStackUpdater(oldStackToNewStack)
    );
  });
}

/**
 * When restoring function in a CallNodePath there can be multiple correct CallNodePaths
 * that could be restored. The best approach would probably be to restore to the
 * "heaviest" callstack in the call tree (i.e. the one that is displayed first in the
 * calltree because it has the most samples under it.) This function only finds the first
 * match and returns it.
 */
export function restoreAllFunctionsInCallNodePath(
  thread: Thread,
  previousImplementationFilter: ImplementationFilter,
  callNodePath: CallNodePath
): CallNodePath {
  const { stackTable, frameTable } = thread;
  const funcMatchesImplementation = FUNC_MATCHES[previousImplementationFilter];
  // For every stackIndex, matchesUpToDepth[stackIndex] will be:
  //  - null if stackIndex does not match the callNodePath
  //  - <depth> if stackIndex matches callNodePath up to (and including) callNodePath[<depth>]
  const matchesUpToDepth = [];
  let tipStackIndex = null;
  // Try to find the tip most stackIndex in the CallNodePath, but skip anything
  // that doesn't match the previous implementation filter.
  for (let stackIndex = 0; stackIndex < stackTable.length; stackIndex++) {
    const prefix = stackTable.prefix[stackIndex];
    const frameIndex = stackTable.frame[stackIndex];
    const funcIndex = frameTable.func[frameIndex];
    const prefixPathDepth = prefix === null ? -1 : matchesUpToDepth[prefix];

    if (prefixPathDepth === null) {
      continue;
    }

    const pathDepth = prefixPathDepth + 1;
    const nextPathFuncIndex = callNodePath[pathDepth];
    if (nextPathFuncIndex === funcIndex) {
      // This function is a match.
      matchesUpToDepth[stackIndex] = pathDepth;
      if (pathDepth === callNodePath.length - 1) {
        // The tip of the CallNodePath has been found.
        tipStackIndex = stackIndex;
        break;
      }
    } else if (!funcMatchesImplementation(thread, funcIndex)) {
      // This function didn't match, but it also wasn't in the previous implementation.
      // Keep on searching for a match.
      matchesUpToDepth[stackIndex] = prefixPathDepth;
    } else {
      matchesUpToDepth[stackIndex] = null;
    }
  }

  // Turn the stack index into a CallNodePath
  if (tipStackIndex === null) {
    return [];
  }
  const newCallNodePath = [];
  for (
    let stackIndex = tipStackIndex;
    stackIndex !== null;
    stackIndex = stackTable.prefix[stackIndex]
  ) {
    const frameIndex = stackTable.frame[stackIndex];
    const funcIndex = frameTable.func[frameIndex];
    newCallNodePath.push(funcIndex);
  }
  return newCallNodePath.reverse();
}

export function getStackType(
  thread: Thread,
  funcIndex: IndexIntoFuncTable
): StackType {
  if (FUNC_MATCHES.cpp(thread, funcIndex)) {
    return 'native';
  } else if (FUNC_MATCHES.js(thread, funcIndex)) {
    return 'js';
  }
  return 'unsymbolicated';
}

export function filterCallNodePathByImplementation(
  thread: Thread,
  implementationFilter: ImplementationFilter,
  callNodePath: CallNodePath
): CallNodePath {
  const funcMatchesImplementation = FUNC_MATCHES[implementationFilter];
  return callNodePath.filter((funcIndex) =>
    funcMatchesImplementation(thread, funcIndex)
  );
}

export function filterCallNodeAndCategoryPathByImplementation(
  thread: Thread,
  implementationFilter: ImplementationFilter,
  path: CallNodeAndCategoryPath
): CallNodeAndCategoryPath {
  const funcMatchesImplementation = FUNC_MATCHES[implementationFilter];
  return path.filter((funcIndex) =>
    funcMatchesImplementation(thread, funcIndex.func)
  );
}

/**
 * Search through the entire call stack and see if there are any examples of
 * recursion.
 */
export function funcHasRecursiveCall(
  thread: Thread,
  implementation: ImplementationFilter,
  funcToCheck: IndexIntoFuncTable
) {
  const { stackTable, frameTable } = thread;
  const recursiveStacks = new Set();
  const funcMatchesImplementation = FUNC_MATCHES[implementation];

  for (let stackIndex = 0; stackIndex < stackTable.length; stackIndex++) {
    const frameIndex = stackTable.frame[stackIndex];
    const prefix = stackTable.prefix[stackIndex];
    const funcIndex = frameTable.func[frameIndex];
    const recursivePrefix = recursiveStacks.has(prefix);

    if (funcToCheck === funcIndex) {
      if (recursivePrefix) {
        // This function matches and so did its prefix of the same implementation.
        return true;
      }
      recursiveStacks.add(stackIndex);
    } else {
      if (recursivePrefix && !funcMatchesImplementation(thread, funcIndex)) {
        recursiveStacks.add(stackIndex);
      }
    }
  }
  return false;
}

export function applyTransform(
  thread: Thread,
  transform: Transform,
  defaultCategory: IndexIntoCategoryList
): Thread {
  switch (transform.type) {
    case 'focus-subtree':
      return transform.inverted
        ? focusInvertedSubtree(
            thread,
            transform.callNodePath,
            transform.implementation
          )
        : focusSubtree(
            thread,
            transform.callNodePath,
            transform.implementation
          );
    case 'merge-call-node':
      return mergeCallNode(
        thread,
        transform.callNodePath,
        transform.implementation
      );
    case 'merge-function':
      return mergeFunction(thread, transform.funcIndex);
    case 'drop-function':
      return dropFunction(thread, transform.funcIndex);
    case 'focus-function':
      return focusFunction(thread, transform.funcIndex);
    case 'collapse-resource':
      return collapseResource(
        thread,
        transform.resourceIndex,
        transform.implementation,
        defaultCategory
      );
    case 'collapse-direct-recursion':
      return collapseDirectRecursion(
        thread,
        transform.funcIndex,
        transform.implementation
      );
    case 'collapse-function-subtree':
      return collapseFunctionSubtree(
        thread,
        transform.funcIndex,
        defaultCategory
      );
    default:
      throw assertExhaustiveCheck(transform);
  }
}
