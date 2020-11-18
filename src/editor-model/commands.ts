import { register } from '../editor/commands';
import type { ModelPrivate } from './model-private';
import { deleteForward, deleteBackward, deleteRange } from './delete';
import { Atom, BranchName } from '../core/atom';
import { SubsupAtom } from '../core-atoms/subsup';
import { getCommandSuggestionRange } from './command-mode';
import { CommandAtom } from '../core-atoms/command';
import { TextAtom } from '../core-atoms/text';
import { LETTER_AND_DIGITS } from '../core-definitions/definitions';
import { Offset } from '../public/mathfield';
import { getMode } from './selection';

/**
 * Return true if the atom could be a part of a number
 * i.e. "-12354.568"
 */
function isNumber(atom: Atom): boolean {
    if (!atom) return false;
    return (
        (atom.type === 'mord' && /[0-9.]/.test(atom.value)) ||
        (atom.type === 'mpunct' && atom.value === ',')
    );
}

/*
 * Calculates the offset of the "next word".
 * This is inspired by the behavior of text editors on macOS, namely:
    blue   yellow
      ^-
         ^-------
 * That is:

 * (1) If starts with an alphanumerical character, find the first alphanumerical
 * character which is followed by a non-alphanumerical character
 *
 * The behavior regarding non-alphanumeric characters is less consistent.
 * Here's the behavior we use:
 *
 *   +=-()_:”     blue
 * ^---------
 *   +=-()_:”     blue
 *      ^---------
 *   +=-()_:”blue
 *      ^--------
 *
 * (2) If starts in whitespace, skip whitespace, then find first non-whitespace*
 *    followed by whitespace
 * (*) Pages actually uses the character class of the first non-whitespace
 * encountered.
 *
 * (3) If starts in a non-whitespace, non alphanumerical character, find the first
 *      whitespace
 *
 */
function wordBoundaryOffset(
    model: ModelPrivate,
    offset: Offset,
    direction: 'forward' | 'backward'
): number {
    if (model.at(offset).mode !== 'text') return offset;
    const dir = direction === 'backward' ? -1 : +1;
    let result;
    if (LETTER_AND_DIGITS.test(model.at(offset).value)) {
        // (1) We start with an alphanumerical character
        let i = offset;
        let match;
        do {
            match =
                model.at(i).mode === 'text' &&
                LETTER_AND_DIGITS.test(model.at(i).value);
            i += dir;
        } while (model.at(i) && match);
        result = model.at(i) ? i - 2 * dir : i - dir;
    } else if (/\s/.test(model.at(offset).value)) {
        // (2) We start with whitespace

        // Skip whitespace
        let i = offset;
        while (
            model.at(i) &&
            model.at(i).mode === 'text' &&
            /\s/.test(model.at(i).value)
        ) {
            i += dir;
        }
        if (!model.at(i)) {
            // We've reached the end
            result = i - dir;
        } else {
            let match = true;
            do {
                match =
                    model.at(i).mode === 'text' &&
                    !/\s/.test(model.at(i).value);
                i += dir;
            } while (model.at(i) && match);
            result = model.at(i) ? i - 2 * dir : i - dir;
        }
    } else {
        // (3)
        let i = offset;
        // Skip non-whitespace
        while (
            model.at(i) &&
            model.at(i).mode === 'text' &&
            !/\s/.test(model.at(i).value)
        ) {
            i += dir;
        }
        result = model.at(i) ? i : i - dir;
        let match = true;
        while (model.at(i) && match) {
            match = model.at(i).mode === 'text' && /\s/.test(model.at(i).value);
            if (match) result = i;
            i += dir;
        }
        result = model.at(i) ? i - 2 * dir : i - dir;
    }

    return result - (dir > 0 ? 0 : 1);
}

export function moveAfterParent(model: ModelPrivate): boolean {
    const previousPosition = model.position;
    if (!model.at(previousPosition).parent) {
        model.announce('plonk');
        return false;
    }
    model.position = model.offsetOf(model.at(model.position).parent);
    model.announce('move', previousPosition);
    return true;
}

/**
 * Switch the cursor to the superscript and select it. If there is no subscript
 * yet, create one.
 */
function moveToSuperscript(model: ModelPrivate): boolean {
    model.collapseSelection();
    if (superscriptDepth(model) >= model.mathfield.options.scriptDepth[1]) {
        model.announce('plonk');
        return false;
    }
    let target = model.at(model.position);

    if (target.limits !== 'limits' && target.limits !== 'auto') {
        // This atom can't have a superscript/subscript:
        // add an adjacent `msubsup` atom instead.
        if (model.at(model.position + 1)?.type !== 'msubsup') {
            target.parent.addChildAfter(
                new SubsupAtom({
                    baseType: target.type,
                    style: model.at(model.position).computedStyle,
                }),
                target
            );
        }
        target = model.at(model.position + 1);
    }
    // Ensure there is a superscript branch
    target.createBranch('superscript');
    model.setSelection(
        model.getSiblingsRange(model.offsetOf(target.superscript[0]))
    );

    return true;
}

/**
 * Switch the cursor to the subscript and select it. If there is no subscript
 * yet, create one.
 */
function moveToSubscript(model: ModelPrivate): boolean {
    model.collapseSelection();
    if (subscriptDepth(model) >= model.mathfield.options.scriptDepth[0]) {
        model.announce('plonk');
        return false;
    }
    let target = model.at(model.position);

    if (target.limits !== 'limits' && target.limits !== 'auto') {
        // This atom can't have a superscript/subscript:
        // add an adjacent `msubsup` atom instead.
        if (model.at(model.position + 1)?.type !== 'msubsup') {
            target.parent.addChildAfter(
                new Atom('msubsup', {
                    mode: target.mode,
                    value: '\u200b',
                    style: model.at(model.position).computedStyle,
                }),
                target
            );
        }
        target = model.at(model.position + 1);
    }
    // Ensure there is a subscript branch
    target.createBranch('subscript');
    model.setSelection(
        model.getSiblingsRange(model.offsetOf(target.subscript[0]))
    );
    return true;
}

/**
 * Keyboard navigation with alt/option:
 * Move the insertion point to the next/previous point of interest.
 * A point of interest is an atom of a different type (mbin, mord, etc...)
 * than the current focus.
 * If `extend` is true, the selection will be extended. Otherwise, it is
 * collapsed, then moved.
 * @param dir +1 to skip forward, -1 to skip back
 * @revisit: to do
 */
function skip(
    model: ModelPrivate,
    direction: 'forward' | 'backward',
    options?: { extend: boolean }
): boolean {
    const previousPosition = model.position;

    if (!(options?.extend ?? false)) {
        model.collapseSelection(direction);
    }
    let atom = model.at(model.position);
    if (direction === 'forward') {
        if (atom.type === 'msubsup') {
            atom = atom.rightSibling;
            if (!atom) {
                atom = model.at(model.position + 1);
            }
        } else {
            atom = model.at(model.position + 1);
        }
    }
    if (!atom) {
        model.announce('plonk');
        return false;
    }
    let offset = model.offsetOf(atom);

    if (atom instanceof TextAtom) {
        //
        // We're in a text zone, skip word by word
        //
        offset = wordBoundaryOffset(model, offset, direction);
    } else if (atom instanceof CommandAtom) {
        //
        // We're in a command zone, skip suggestion
        //
        if (atom.isSuggestion) {
            // Since suggestions are always at the end, this must be forward
            console.assert(direction === 'forward');
            while (atom && atom instanceof CommandAtom) {
                atom.isSuggestion = false;
                offset = model.offsetOf(atom);
                atom = atom.rightSibling;
            }
        } else {
            if (direction === 'forward') {
                atom = atom.rightSibling;
                if (!atom || !(atom instanceof CommandAtom)) {
                    // At the end of the command
                    model.announce('plonk');
                    return false;
                }
                while (
                    atom &&
                    atom instanceof CommandAtom &&
                    /[a-zA-Z\*]/.test(atom.value)
                ) {
                    offset = model.offsetOf(atom);
                    atom = atom.rightSibling;
                }
            } else {
                atom = atom.leftSibling;
                if (!atom || !(atom instanceof CommandAtom)) {
                    // At the start of the command
                    model.announce('plonk');
                    return false;
                }
                while (
                    atom &&
                    atom instanceof CommandAtom &&
                    /[a-zA-Z\*]/.test(atom.value)
                ) {
                    offset = model.offsetOf(atom);
                    atom = atom.leftSibling;
                }
            }
        }
    } else if (direction === 'forward' && atom.type === 'mopen') {
        //
        // Right before a 'mopen', skip to the corresponding balanced fence
        //
        let level = 0;
        do {
            if (atom.type === 'mopen') {
                level += 1;
            } else if (atom.type === 'mclose') {
                level -= 1;
            }
            atom = atom.rightSibling;
        } while (!atom.isLastSibling && level !== 0);
        offset = model.offsetOf(atom.leftSibling);
    } else if (direction === 'backward' && atom.type === 'mclose') {
        //
        // Right after a 'mclose', skip to the corresponding balanced fence
        //
        let level = 0;
        do {
            if (atom.type === 'mopen') {
                level += 1;
            } else if (atom.type === 'mclose') {
                level -= 1;
            }
            atom = atom.leftSibling;
        } while (!atom.isFirstSibling && level !== 0);
        offset = model.offsetOf(atom);
    } else {
        //
        // We're in a regular math zone (not before/after a fence)
        //
        if (direction === 'backward') {
            if (atom.type === 'first') {
                while (offset > 0 && atom.type === 'first') {
                    offset -= 1;
                    atom = model.at(offset);
                }
            } else {
                const type =
                    atom instanceof SubsupAtom ? atom.baseType : atom.type;
                if (atom.type === 'msubsup') {
                    // If we're after a 'msubsup', skip to its left sibling
                    // (the base of the super/subscript)
                    offset = model.offsetOf(model.at(offset).leftSibling);
                }
                offset -= 1;
                let nextType = model.at(offset)?.type;
                // if (nextType === 'msubsup') {
                //     offset = model.offsetOf(model.at(offset).leftSibling);
                // }
                while (offset >= 0 && nextType === type) {
                    if (model.at(offset)?.type === 'msubsup') {
                        offset = model.offsetOf(model.at(offset).leftSibling);
                    } else {
                        offset -= 1;
                    }
                    nextType = model.at(offset).type;
                }
            }
        } else {
            const type = atom.type;
            // if (atom.type === 'msubsup') {
            //     offset = model.offsetOf(model.at(offset).rightSibling);
            // }
            let nextType = model.at(offset)?.type;
            const lastOffset = model.lastOffset;
            while (
                offset <= lastOffset &&
                (nextType === type || nextType === 'msubsup')
            ) {
                while (model.at(offset).rightSibling?.type === 'msubsup') {
                    offset = model.offsetOf(model.at(offset).rightSibling);
                }
                offset += 1;
                nextType = model.at(offset)?.type;
            }
            offset -= 1;
        }
    }

    if (options?.extend ?? false) {
        if (!model.setSelection(model.anchor, offset)) {
            model.announce('plonk');
            return false;
        }
    } else {
        if (offset === model.position) {
            model.announce('plonk');
            return false;
        }
        model.position = offset;
    }
    model.announce('move', previousPosition);
    return true;
}

/**
 * Select all the atoms in the current group, that is all the siblings.
 * When the selection is in a numerator, the group is the numerator. When
 * the selection is a superscript or subscript, the group is the supsub.
 * When the selection is in a text zone, the "group" is a word.
 */
export function selectGroup(model: ModelPrivate): boolean {
    if (getMode(model, model.position) === 'text') {
        let start = Math.min(model.anchor, model.position);
        let end = Math.max(model.anchor, model.position);
        //
        let done = false;
        while (!done && start > 0) {
            const atom = model.at(start);
            if (atom.mode === 'text' && LETTER_AND_DIGITS.test(atom.value)) {
                start -= 1;
            } else {
                done = true;
            }
        }
        done = false;
        while (!done && end <= model.lastOffset) {
            const atom = model.at(end);
            if (atom.mode === 'text' && LETTER_AND_DIGITS.test(atom.value)) {
                end += 1;
            } else {
                done = true;
            }
        }
        if (done) {
            end -= 1;
        }
        if (start >= end) {
            // No word found. Select a single character
            model.setSelection(end - 1, end);
            return true;
        }

        model.setSelection(start, end);
    } else {
        const atom = model.at(model.position);
        // In a math zone, select all the sibling nodes
        if (isNumber(atom)) {
            // In a number, select all the digits
            let start = Math.min(model.anchor, model.position);
            let end = Math.max(model.anchor, model.position);
            //
            while (isNumber(model.at(start))) start -= 1;
            while (isNumber(model.at(end))) end += 1;
            model.setSelection(start, end - 1);
        } else {
            model.setSelection(
                model.offsetOf(atom.firstSibling),
                model.offsetOf(atom.lastSibling)
            );
        }
    }
    return true;
}

/**
 * Handle keyboard navigation (arrow keys)
 */
export function move(
    model: ModelPrivate,
    direction: 'forward' | 'backward' | 'upward' | 'downward',
    options?: { extend: boolean }
): boolean {
    options = options ?? { extend: false };

    deleteRange(model, getCommandSuggestionRange(model));

    if (direction === 'upward') return moveUpward(model, options);
    if (direction === 'downward') return moveDownward(model, options);

    const previousPosition = model.position;

    if (options.extend) {
        return model.extendSelection(direction);
    }
    if (model.selectionIsPlaceholder) {
        model.collapseSelection(direction);
        return move(model, direction);
    }
    if (!model.collapseSelection(direction)) {
        let pos = model.position + (direction === 'forward' ? +1 : -1);

        //
        // 1. Handle `captureSelection` and `skipBoundary`
        //
        if (direction === 'forward') {
            const atom = model.at(model.position + 1);
            if (atom?.parent?.captureSelection) {
                // When going forward, if in a capture selection, jump to
                // after
                pos = model.offsetOf(atom?.parent.lastChild) + 1;
            } else if (atom?.skipBoundary) {
                // When going forward if next is skipboundary, move 2
                pos += 1;
            }
        } else if (direction === 'backward') {
            const atom = model.at(model.position - 1);
            if (atom?.parent?.captureSelection) {
                // When going backward, if in a capture selection, jump to
                // before
                pos = Math.max(0, model.offsetOf(atom?.parent.firstChild) - 1);
            } else if (atom?.isFirstSibling && atom.parent?.skipBoundary) {
                // When going backward, if land on first of group and previous is
                // skipbounday,  move -2
                pos -= 1;
            }
        }

        //
        // 2. Handle out of bounds
        //
        if (pos < 0 || pos > model.lastOffset) {
            // We're going out of bounds
            let result = true; // true => perform default handling
            if (!model.suppressChangeNotifications) {
                result = model.hooks?.moveOut(model, direction);
            }
            if (result) model.announce('plonk');
            return result;
        }

        //
        // 3. Handle placeholder
        //
        if (model.at(pos)?.type === 'placeholder') {
            // We're going right of a placeholder: select it
            model.setSelection(pos - 1, pos);
        } else if (model.at(pos)?.rightSibling?.type === 'placeholder') {
            // We're going left of a placeholder: select it
            model.setSelection(pos, pos + 1);
        } else {
            model.position = pos;
        }
    }
    model.announce('move', previousPosition);
    return true;
}

function moveUpward(
    model: ModelPrivate,
    options?: { extend: boolean }
): boolean {
    const extend = options?.extend ?? false;

    model.collapseSelection('backward');
    // Find a target branch
    // This is to handle the case: `\frac{x}{\sqrt{y}}`. If we're at `y`
    // we'd expectto move to `x`, even though `\sqrt` doesn't have an 'above'
    // branch, but one of its ancestor does.
    let atom = model.at(model.position);
    while (atom && atom.treeBranch !== 'below') {
        atom = atom.parent;
    }

    if (atom) {
        if (extend) {
            model.setSelection(
                model.offsetOf(atom.parent.leftSibling),
                model.offsetOf(atom.parent)
            );
        } else {
            // If branch doesn't exist, create it
            const branch =
                atom.parent.branch('above') ??
                atom.parent.createBranch('above');

            // Move to the last atom of the branch
            model.position = model.offsetOf(branch[branch.length - 1]);
        }
        model.announce('move up');
        // } else if (model.parent.array) {
        //     // In an array
        //     let colRow = arrayColRow(model.parent.array, relation);
        //     colRow = arrayAdjustRow(model.parent.array, colRow, -1);
        //     if (colRow && arrayCell(model.parent.array, colRow)) {
        //         model.path[model.path.length - 1].relation = ('cell' +
        //             arrayIndex(model.parent.array, colRow)) as Relation;
        //         setSelectionOffset(model, model.anchorOffset());

        //         model.announce('moveUp');
        //     } else {
        //         move(model, 'backward', options);
        //     }
    } else {
        if (!model.at(model.position).parent?.parent) {
            let result = true; // true => perform default handling
            if (!model.suppressChangeNotifications) {
                result = model.hooks?.moveOut(model, 'upward');
            }
            model.announce(result ? 'plonk' : 'line');
            return result;
        }
    }
    return true;
}

function moveDownward(
    model: ModelPrivate,
    options?: { extend: boolean }
): boolean {
    const extend = options?.extend ?? false;

    model.collapseSelection('forward');
    let atom = model.at(model.position);
    while (atom && atom.treeBranch !== 'above') {
        atom = atom.parent;
    }

    if (atom) {
        if (extend) {
            model.setSelection(
                model.offsetOf(atom.parent.leftSibling),
                model.offsetOf(atom.parent)
            );
        } else {
            // If branch doesn't exist, create it
            const branch =
                atom.parent.branch('below') ??
                atom.parent.createBranch('below');

            // Move to the last atom of the branch
            model.position = model.offsetOf(branch[branch.length - 1]);
        }
        model.announce('move down');
        //     // In an array
        //     let colRow = arrayColRow(model.parent.array, relation);
        //     colRow = arrayAdjustRow(model.parent.array, colRow, +1);
        //     // @revisit: validate this codepath
        //     if (colRow && arrayCell(model.parent.array, colRow)) {
        //         model.path[model.path.length - 1].relation = ('cell' +
        //             arrayIndex(model.parent.array, colRow)) as Relation;
        //         setSelectionOffset(model, model.anchorOffset());
        //         model.announce('moveDown');
        //     } else {
        //         move(model, 'forward', options);
        //     }
    } else {
        if (!model.at(model.position).parent?.parent) {
            let result = true; // true => perform default handling
            if (!model.suppressChangeNotifications) {
                result = model.hooks?.moveOut(model, 'downward');
            }
            model.announce(result ? 'plonk' : 'line');
            return result;
        }
    }

    return true;
}

/**
 * Move to the next/previous placeholder or empty child list.
 * @return False if no placeholder found and did not move
 */
function leap(
    model: ModelPrivate,
    dir: 'forward' | 'backward',
    callHooks = true
): boolean {
    const dist = dir === 'forward' ? 1 : -1;
    if (model.at(model.anchor).type === 'placeholder') {
        // If we're already at a placeholder, move by one more (the placeholder
        // is right after the insertion point)
        move(model, dir);
    }
    // Candidate placeholders are atom of type 'placeholder'
    // or empty children list (except for the root: if the root is empty,
    // it is not a valid placeholder)
    const atoms = model.getAllAtoms(model.position + dist);
    if (dir === 'backward') atoms.reverse();
    const placeholders = atoms.filter(
        (atom) =>
            atom.type === 'placeholder' ||
            (atom.treeDepth > 0 && atom.isFirstSibling && atom.isLastSibling)
    );

    // If no placeholders were found, call handler or move to the next focusable
    // element in the document
    if (placeholders.length === 0) {
        const handled = !callHooks || !model.hooks.tabOut?.(model, dir);
        if (handled) {
            model.announce('plonk');
            return false;
        }
        const tabbable = getTabbableElements();
        if (!document.activeElement || tabbable.length === 1) {
            model.announce('plonk');
            return false;
        }
        let index =
            tabbable.indexOf(document.activeElement as HTMLElement) + dist;
        if (index < 0) index = tabbable.length - 1;
        if (index >= tabbable.length) index = 0;
        tabbable[index].focus();

        if (index === 0) {
            model.announce('plonk');
            return false;
        }
        return true;
    }

    // Set the selection to the next placeholder
    const previousPosition = model.position;
    const newPosition = model.offsetOf(placeholders[0]);
    if (placeholders[0].type === 'placeholder') {
        model.setSelection(newPosition - 1, newPosition);
    } else {
        model.position = newPosition;
    }
    model.announce('move', previousPosition);
    return true;
}

/**
 * Return an array of tabbable elements, approximately in the order a browser
 * would (the browsers are inconsistent), which is first by accounting
 * for non-null tabIndex, then null tabIndex, then document order of focusable
 * elements.
 */
function getTabbableElements(): HTMLElement[] {
    // const focussableElements = `a[href]:not([disabled]),
    // button:not([disabled]),
    // textarea:not([disabled]),
    // input[type=text]:not([disabled]),
    // select:not([disabled]),
    // [contentEditable="true"],
    // [tabindex]:not([disabled]):not([tabindex="-1"])`;
    // // Get all the potentially focusable elements
    // // and exclude (1) those that are invisible (width and height = 0)
    // // (2) not the active element
    // // (3) the ancestor of the active element

    // return Array.prototype.filter.call(
    //     document.querySelectorAll(focussableElements),
    //     (element) =>
    //         ((element.offsetWidth > 0 || element.offsetHeight > 0) &&
    //             !element.contains(document.activeElement)) ||
    //         element === document.activeElement
    // );

    function tabbable(el: HTMLElement) {
        const regularTabbables = [];
        const orderedTabbables = [];

        const candidates = Array.from(
            el.querySelectorAll<
                HTMLElement
            >(`input, select, textarea, a[href], button, 
        [tabindex], audio[controls], video[controls],
        [contenteditable]:not([contenteditable="false"]), details>summary`)
        ).filter(isNodeMatchingSelectorTabbable);

        candidates.forEach((candidate, i) => {
            const candidateTabindex = getTabindex(candidate);
            if (candidateTabindex === 0) {
                regularTabbables.push(candidate);
            } else {
                orderedTabbables.push({
                    documentOrder: i,
                    tabIndex: candidateTabindex,
                    node: candidate,
                });
            }
        });

        return orderedTabbables
            .sort((a, b) =>
                a.tabIndex === b.tabIndex
                    ? a.documentOrder - b.documentOrder
                    : a.tabIndex - b.tabIndex
            )
            .map((a) => a.node)
            .concat(regularTabbables);
    }

    function isNodeMatchingSelectorTabbable(el: HTMLElement): boolean {
        if (
            !isNodeMatchingSelectorFocusable(el) ||
            isNonTabbableRadio(el) ||
            getTabindex(el) < 0
        ) {
            return false;
        }
        return true;
    }

    function isNodeMatchingSelectorFocusable(node) {
        if (
            node.disabled ||
            (node.tagName === 'INPUT' && node.type === 'hidden') ||
            isHidden(node)
        ) {
            return false;
        }
        return true;
    }

    function getTabindex(node: HTMLElement): number {
        const tabindexAttr = parseInt(node.getAttribute('tabindex'), 10);

        if (!isNaN(tabindexAttr)) {
            return tabindexAttr;
        }

        // Browsers do not return `tabIndex` correctly for contentEditable nodes;
        // so if they don't have a tabindex attribute specifically set, assume it's 0.
        if (node.contentEditable === 'true') {
            return 0;
        }

        // in Chrome, <audio controls/> and <video controls/> elements get a default
        //  `tabIndex` of -1 when the 'tabindex' attribute isn't specified in the DOM,
        //  yet they are still part of the regular tab order; in FF, they get a default
        //  `tabIndex` of 0; since Chrome still puts those elements in the regular tab
        //  order, consider their tab index to be 0
        if (
            (node.nodeName === 'AUDIO' || node.nodeName === 'VIDEO') &&
            node.getAttribute('tabindex') === null
        ) {
            return 0;
        }

        return node.tabIndex;
    }

    function isNonTabbableRadio(node: HTMLElement): boolean {
        return (
            node.tagName === 'INPUT' &&
            (node as HTMLInputElement).type === 'radio' &&
            !isTabbableRadio(node as HTMLInputElement)
        );
    }

    function getCheckedRadio(nodes, form) {
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].checked && nodes[i].form === form) {
                return nodes[i];
            }
        }
        return null;
    }

    function isTabbableRadio(node: HTMLInputElement): boolean {
        if (!node.name) {
            return true;
        }
        const radioScope = node.form || node.ownerDocument;
        const radioSet = radioScope.querySelectorAll(
            'input[type="radio"][name="' + node.name + '"]'
        );
        const checked = getCheckedRadio(radioSet, node.form);
        return !checked || checked === node;
    }

    function isHidden(el: HTMLElement) {
        if (
            el === document.activeElement ||
            el.contains(document.activeElement)
        ) {
            return false;
        }

        if (getComputedStyle(el).visibility === 'hidden') return true;

        // Note that browsers generally don't consider the bounding rect
        // as a criteria to determine if an item is focusable, but we want
        // to exclude the invisible textareas used to capture keyoard input.
        const bounds = el.getBoundingClientRect();
        if (bounds.width === 0 || bounds.height === 0) return true;

        while (el) {
            if (getComputedStyle(el).display === 'none') return true;
            el = el.parentElement;
        }

        return false;
    }
    return tabbable(document.body);
}

/**
 * If cursor is currently in:
 * - superscript: move to subscript, creating it if necessary
 * - subscript: move to superscript, creating it if necessary
 * - numerator: move to denominator
 * - denominator: move to numerator
 * - otherwise: move to superscript
 */
register(
    {
        moveToOpposite: (model: ModelPrivate): boolean => {
            const OPPOSITE_RELATIONS = {
                superscript: 'subscript',
                subscript: 'superscript',
                above: 'below',
                below: 'above',
            };
            const cursor = model.at(model.position);
            const parent = cursor.parent;
            if (!parent) {
                model.announce('plonk');
                return false;
            }
            const relation = cursor.treeBranch;
            let oppositeRelation: BranchName;
            if (typeof relation === 'string') {
                oppositeRelation = OPPOSITE_RELATIONS[relation];
            }
            if (!oppositeRelation) {
                if (!cursor.limits) {
                    return moveToSuperscript(model);
                }
                return moveToSubscript(model);
            }

            if (!parent.branch(oppositeRelation)) {
                // Don't have children of the opposite relation yet
                // Add them
                parent.createBranch(oppositeRelation);
            }

            return model.setSelection(
                model.getBranchRange(model.offsetOf(parent), oppositeRelation)
            );
        },
        moveBeforeParent: (model: ModelPrivate): boolean => {
            const parent = model.at(model.position).parent;
            if (!parent) {
                model.announce('plonk');
                return false;
            }
            model.position = model.offsetOf(parent);
            return true;
        },
        moveAfterParent: (model: ModelPrivate): boolean =>
            moveAfterParent(model),

        moveToNextPlaceholder: (model: ModelPrivate): boolean =>
            leap(model, 'forward'),
        moveToPreviousPlaceholder: (model: ModelPrivate): boolean =>
            leap(model, 'backward'),
        moveToNextChar: (model: ModelPrivate): boolean =>
            move(model, 'forward'),
        moveToPreviousChar: (model: ModelPrivate): boolean =>
            move(model, 'backward'),
        moveUp: (model: ModelPrivate): boolean => move(model, 'upward'),
        moveDown: (model: ModelPrivate): boolean => move(model, 'downward'),
        moveToNextWord: (model: ModelPrivate): boolean =>
            skip(model, 'forward'),
        moveToPreviousWord: (model: ModelPrivate): boolean =>
            skip(model, 'backward'),
        moveToGroupStart: (model: ModelPrivate): boolean => {
            const pos = model.offsetOf(model.at(model.position).firstSibling);
            if (pos === model.position) {
                model.announce('plonk');
                return false;
            }
            model.position = pos;
            return true;
        },
        moveToGroupEnd: (model: ModelPrivate): boolean => {
            const pos = model.offsetOf(model.at(model.position).lastSibling);
            if (pos === model.position) {
                model.announce('plonk');
                return false;
            }
            model.position = pos;
            return true;
        },
        moveToMathFieldStart: (model: ModelPrivate): boolean => {
            if (model.position === 0) {
                model.announce('plonk');
                return false;
            }
            model.position = 0;
            return true;
        },
        moveToMathFieldEnd: (model: ModelPrivate): boolean => {
            if (model.position === model.lastOffset) {
                model.announce('plonk');
                return false;
            }
            model.position = model.lastOffset;
            return true;
        },
        moveToSuperscript: (model: ModelPrivate): boolean =>
            moveToSuperscript(model),
        moveToSubscript: (model: ModelPrivate): boolean =>
            moveToSubscript(model),
    },
    { target: 'model', category: 'selection-anchor' }
);

register(
    {
        selectGroup: (model: ModelPrivate): boolean => {
            const result = selectGroup(model);
            if (!result) model.announce('plonk');
            return result;
        },

        selectAll: (model: ModelPrivate): boolean =>
            model.setSelection(0, model.lastOffset),
        extendSelectionForward: (model: ModelPrivate): boolean => {
            const result = model.extendSelection('forward');
            if (!result) model.announce('plonk');
            return result;
        },
        extendSelectionBackward: (model: ModelPrivate): boolean => {
            const result = model.extendSelection('backward');
            if (!result) model.announce('plonk');
            return result;
        },

        extendToNextWord: (model: ModelPrivate): boolean =>
            skip(model, 'forward', { extend: true }),
        extendToPreviousWord: (model: ModelPrivate): boolean =>
            skip(model, 'backward', { extend: true }),
        extendSelectionUpward: (model: ModelPrivate): boolean =>
            move(model, 'upward', { extend: true }),
        extendSelectionDownward: (model: ModelPrivate): boolean =>
            move(model, 'downward', { extend: true }),
        /**
         * Extend the selection until the next boundary is reached. A boundary
         * is defined by an atom of a different type (mbin, mord, etc...)
         * than the current focus. For example, in "1234+x=y", if the focus is between
         * "1" and "2", invoking `extendToNextBoundary_` would extend the selection
         * to "234".
         */
        extendToNextBoundary: (model: ModelPrivate): boolean =>
            skip(model, 'forward', { extend: true }),
        /**
         * Extend the selection until the previous boundary is reached. A boundary
         * is defined by an atom of a different type (mbin, mord, etc...)
         * than the current focus. For example, in "1+23456", if the focus is between
         * "5" and "6", invoking `extendToPreviousBoundary` would extend the selection
         * to "2345".
         */
        extendToPreviousBoundary: (model: ModelPrivate): boolean =>
            skip(model, 'backward', { extend: true }),
        extendToGroupStart: (model: ModelPrivate): boolean => {
            const result = model.setSelection(
                model.anchor,
                model.offsetOf(model.at(model.position).firstSibling)
            );
            if (!result) model.announce('plonk');
            return result;
        },
        extendToGroupEnd: (model: ModelPrivate): boolean => {
            const result = model.setSelection(
                model.anchor,
                model.offsetOf(model.at(model.position).lastSibling)
            );
            if (!result) model.announce('plonk');
            return result;
        },
        extendToMathFieldStart: (model: ModelPrivate): boolean => {
            const result = model.setSelection(model.anchor, 0);
            if (!result) model.announce('plonk');
            return result;
        },
        extendToMathFieldEnd: (model: ModelPrivate): boolean => {
            const result = model.setSelection(model.anchor, model.lastOffset);
            if (!result) model.announce('plonk');
            return result;
        },
    },
    { target: 'model', category: 'selection-extend' }
);

function superscriptDepth(model: ModelPrivate): number {
    let result = 0;
    let atom = model.at(model.position);
    let wasSuperscript = false;
    while (atom) {
        if (
            !atom.hasEmptyBranch('superscript') ||
            !atom.hasEmptyBranch('subscript')
        ) {
            result += 1;
        }
        if (!atom.hasEmptyBranch('superscript')) {
            wasSuperscript = true;
        } else if (!atom.hasEmptyBranch('subscript')) {
            wasSuperscript = false;
        }
        atom = atom.parent;
    }
    return wasSuperscript ? result : 0;
}
function subscriptDepth(model: ModelPrivate): number {
    let result = 0;
    let atom = model.at(model.position);
    let wasSubscript = false;
    while (atom) {
        if (
            !atom.hasEmptyBranch('superscript') ||
            !atom.hasEmptyBranch('subscript')
        ) {
            result += 1;
        }
        if (!atom.hasEmptyBranch('superscript')) {
            wasSubscript = false;
        } else if (!atom.hasEmptyBranch('subscript')) {
            wasSubscript = true;
        }
        atom = atom.parent;
    }
    return wasSubscript ? result : 0;
}

register(
    {
        deleteAll: (model: ModelPrivate): boolean => {
            return deleteRange(model, [0, -1]);
        },
        deleteForward: (model: ModelPrivate): boolean => deleteForward(model),
        deleteBackward: (model: ModelPrivate): boolean => deleteBackward(model),
        deleteNextWord: (model: ModelPrivate): boolean =>
            deleteRange(model, [
                model.anchor,
                wordBoundaryOffset(model, model.position, 'forward'),
            ]),
        deletePreviousWord: (model: ModelPrivate): boolean =>
            deleteRange(model, [
                model.anchor,
                wordBoundaryOffset(model, model.position, 'backward'),
            ]),
        deleteToGroupStart: (model: ModelPrivate): boolean =>
            deleteRange(model, [
                model.anchor,
                model.offsetOf(model.at(model.position).firstSibling),
            ]),
        deleteToGroupEnd: (model: ModelPrivate): boolean =>
            deleteRange(model, [
                model.anchor,
                model.offsetOf(model.at(model.position).lastSibling),
            ]),
        deleteToMathFieldStart: (model: ModelPrivate): boolean =>
            deleteRange(model, [model.anchor, 0]),
        deleteToMathFieldEnd: (model: ModelPrivate): boolean =>
            deleteRange(model, [model.anchor, -1]),
    },
    { target: 'model', category: 'delete' }
);
