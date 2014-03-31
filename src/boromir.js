/**
 * "One does not simply mutate the DOM" - Boromir
 *
 * Boromir - represent a DOM with immutable javascript data structures
 * (arrays and objects), transform the representation with functional
 * algorithms (no update in place), and efficiently update the DOM from
 * the transformed representation.
 *
 * Uses cases:
 *
 * present a normalized view (no empty text nodes, subsequent text nodes
 *   joined) (wouldn't call normalize() unnecessarily with a DOM
 *   representation),
 * 
 * shadow-dom - ignore shadow-dom/ephemera/non-visible elements for the
 *   purpose of the algorithm - whether or not ephemera/non-visible
 *   elements can be ignored completely depends on the algorithm - for
 *   example when inserting a node, does it matter whether it comes
 *   after or before a non-visible or ephemera node? - what is
 *   considered shadow DOM and what isn't is controllable,
 * 
 * inject ranges in the the content (wouldn't do it with the DOM,
 *   especially if the algorithm is read-only (read algorithms shouldn't
 *   mutate, otherwise composability is affected))
 * 
 * inject things like arrays into the content to allow a more convenient
 *   structure to be seen (wouldn't do it with the DOM, see above)
 * 
 * any mutate algorithms is also a read-only algorithm - apply a
 *   mutating algorithm and interpret the result without mutating the
 *   DOM directly (can clone the DOM and mutate the clone, but the
 *   mapping back to the DOM would be lost, also efficiency)
 * 
 * as-if algorithms - insert content into the tree without mutating the
 *   DOM, and apply algorithms as if the content was there, and
 *   interpret the results
 *
 * schema validation decoupled from algorithms (invalid DOM structure
 *   never inserted into the DOM, and multiple anti-violation strategies
 *   possible like don't mutate anything on violation (rollback), or
 *   automatically clean invalid nesting and try to preserve valid
 *   content).
 * 
 * immutable datastructure - functional programming - no suprising
 *   mutation effects in an algorithm (impossible with the DOM).
 * 
 * no surprises like walking up the ancestors - does your algorithm
 *   require to be attached to an editable, or not? dom nodes implicity
 *   carry around the context with them, which is fragile in practice
 *   (if I pass the dom node, what else do I really pass?).
 * 
 * read once, write once (otherwise, either within an algorithm, or even
 *   if an algorithm itself does read-once write-once, when composing
 *   multiple algoirthms, you'd have read multiple times, write multiple
 *   times)
 * 
 * optimal DOM updating (no split text node and re-insert, then split
 *   again reinsert and join and reinsert etc.)
 */
define([
	'functions',
	'maps',
	'accessor',
	'record',
	'dom',
	'assert'
], function (
	Fn,
	Maps,
	Accessor,
	Record,
	Dom,
	Assert
) {
	'use strict';

	var idCounter = 0;
	var NO_CHANGE = 0;
	var CHANGE_INSERT = 1;
	var CHANGE_REMOVE = 2;
	var CHANGE_REF = 4;
	var CHANGE_REF_AFFINITY_DOM = 8;
	var CHANGE_REF_AFFINITY_MODEL = 16;
	var AFFINITY_DOM = 1;
	var AFFINITY_MODEL = 2;
	var AFFINITY_DEFAULT = AFFINITY_DOM | AFFINITY_MODEL;

	function nestedGetter(field, nestedField) {
		return function (node) {
			return nestedField.get(field.get(node));
		};
	}

	function type(node) {
		return node.domNode.get(node).nodeType;
	}

	function unchangedAttrs(node) {
		var attrs = Dom.attrs(node.domNode.get(node));
		Maps.extend(cachedAttrs.get(node), attrs);
		return attrs;
	}

	function unchangedChildren(node) {
		var domNode = node.domNode.get(node);
		var childNodes = domNode.childNodes;
		var nodes = [];
		for (var i = 0, len = childNodes.length; i < len; i++) {
			nodes.push(Node(childNodes[i]));
		}
		return nodes;
	}

	function children(node) {
		return node.unchangedChildren.get(node);
	}

	function unchangedName(node) {
		return node.domNode.get(node).nodeName;
	}

	function name(node) {
		return node.unchangedName.get(node);
	}

	function setName(node, name, set) {
		Assert.assertNotNou(name);
		return set(node, name);
	}

	function unchangedText(node) {
		return node.domNode.get(node).data;
	}

	function text(node) {
		return node.unchangedText.get(node);
	}

	function setText(node, text, set) {
		Assert.assertNotNou(text);
		return set(node, text);
	}

	function attrs(node) {
		var unchangedAttrs = node.unchangedAttrs.get(node);
		var changedAttrs = node.changedAttrs.get(node);
		var attrs = Maps.extend({}, unchangedAttrs, changedAttrs);
		delete attrs['style'];
		return Maps.filter(attrs, Fn.complement(Fn.isNou));
	}

	function assertStyleNotAsAttr(cond) {
		Assert.assert(cond, Assert.STYLE_NOT_AS_ATTR);
	}

	function assertElement(node) {
		Assert.assert(1 === node.type.get(node), Assert.EXPECT_ELEMENT);
	}

	function assertTextNode(node) {
		Assert.assert(3 === node.type.get(node), Assert.EXPECT_TEXT_NODE);
	}

	function setAttrsAffectChanges(node, attrs, set) {
		Assert.assertNotNou(attrs);
		assertStyleNotAsAttr(Fn.isNou(attrs['style']));
		var unchangedAttrs = node.unchangedAttrs.get(node);
		var removedAttrs = Maps.fillKeys({}, Maps.keys(unchangedAttrs), null);
		var changedAttrs = Maps.extend(removedAttrs, attrs);
		node = set(node, attrs);
		node = node.changedAttrs.set(node, changedAttrs);
		return node;
	}

	function getChangedOrCachedFromElem(node, name, changedField, cachedField, getFromDomNode) {
		var changedMap = changedField.get(node);
		if (changedMap && changedMap.hasOwnProperty(name)) {
			return changedMap[name];
		}
		var cached = cachedField.get(node);
		if (cached.hasOwnProperty(name)) {
			return cached[name];
		}
		assertElement(node);
		var domNode = node.domNode.get(node);
		var value = cached[name] = getFromDomNode(domNode, name);
		return value;
	}

	function updateInMapField(node, field, name, value) {
		var changedMap = field.get(node) || {};
		var updatedMap = Maps.cloneSet(changedMap, name, value);
		return field.set(node, updatedMap);
	}

	function getAttr(node, name) {
		assertStyleNotAsAttr('style' !== name);
		assertElement(node);
		return getChangedOrCachedFromElem(node, name, node.changedAttrs,
		                                  cachedAttrs, Dom.getAttr);
	}

	function setAttrAffectChanges(node, name, value) {
		assertStyleNotAsAttr('style' !== name);
		assertElement(node);
		node = updateInMapField(node, node.changedAttrs, name, value);
		node = node.attrs.compute(node, node);
		return node;
	}

	function getStyle(node, name) {
		return getChangedOrCachedFromElem(node, name, node.changedStyles,
		                                  cachedStyles, Dom.getStyle);
	}

	function setStyleAffectChanges(node, name, value) {
		return updateInMapField(node, node.changedStyles, name, value);
	}

	function indexChildren(children, index, value) {
		children.forEach(function (child) {
			index[child.id.get(child)] = value;
		});
		return index;
	}

	/**
	 * Fast for common cases, but may have a suboptimal result (too many
	 * removes/inserts) when siblings are moved around rather than just
	 * inserted and removed.
	 */
	function combineChildrenWithChangeInParent(oldChildren, newChildren) {
		var newIndex = indexChildren(newChildren, {}, true);
		var i = 0;
		var j = 0;
		var oldLen = oldChildren.length;
		var newLen = newChildren.length;
		var children = [];
		var changed = false;
		while (i < oldLen && j < newLen) {
			var oldChild = oldChildren[i];
			var newChild = newChildren[j];
			var oldId = oldChild.id.get(oldChild);
			var newId = newChild.id.get(newChild);
			if (oldId === newId) {
				if (oldChild !== newChild) {
					changed = true;
					var change = CHANGE_REF;
					var oldAffinity = oldChild.affinity.get(oldChild);
					var newAffinity = newChild.affinity.get(newChild);
					if ((oldAffinity & AFFINITY_DOM) !== (newAffinity & AFFINITY_DOM)) {
						change = change | CHANGE_REF_AFFINITY_DOM;
					}
					if ((oldAffinity & AFFINITY_MODEL) !== (newAffinity & AFFINITY_MODEL)) {
						change = change | CHANGE_REF_AFFINITY_MODEL;
					}
					newChild = newChild.changedInParent.set(newChild, change);
				}
				children.push(newChild);
				i += 1;
				j += 1;
			} else if (!newIndex[oldId]) {
				changed = true;
				children.push(oldChild.changedInParent.set(oldChild, CHANGE_REMOVE));
				i += 1;
			} else {
				changed = true;
				children.push(newChild.changedInParent.set(newChild, CHANGE_INSERT));
				j += 1;
			}
		}
		for (; i < oldLen; i++) {
			var oldChild = oldChildren[i];
			changed = true;
			children.push(oldChild.changedInParent.set(oldChild, CHANGE_REMOVE));
		}
		for (; j < newLen; j++) {
			var newChild = newChildren[j];
			changed = true;
			children.push(newChild.changedInParent.set(newChild, CHANGE_INSERT));
		}
		if (!changed) {
			return null;
		}
		return children;
	}

	function changedChildren(node) {
		if (!node.children.isMemoized(node)) {
			return null;
		}
		var children = node.children.get(node)
		var unchangedChildren = node.unchangedChildren.get(node)
		if (children === unchangedChildren) {
			return null;
		}
		return combineChildrenWithChangeInParent(unchangedChildren, children);
	}

	function setChildrenAffectChanges(node, children, set) {
		Assert.assertNotNou(children);
		node = set(node, children);
		node = node.changedChildren.compute(node, node);
		return node;
	}

	function allocateId() {
		return ++idCounter;
	}

	var Node = Record.define({
		name               : {compute: name    , set: setName},
		text               : {compute: text    , set: setText},
		// excludes style attribute
		attrs              : {compute: attrs   , set: setAttrsAffectChanges},
		children           : {compute: children, set: setChildrenAffectChanges},
		affinity           : {defaultValue: AFFINITY_DEFAULT},
		// Constant properties
		domNode            : {defaultValue: null},
		id                 : {compute: allocateId},
		type               : {compute: type},
		// Properties used for change-tracking, must be kept in sync
		// with the unchanged and current properties.
		changedStyles      : {defaultValue: null},
		changedAttrs       : {defaultValue: null},
		changedChildren    : {compute: changedChildren},
		changedInParent    : {defaultValue: NO_CHANGE},
		// Cached properties of the domNode, must be kept in sync with
		// the domNode.
		unchangedName      : {compute: unchangedName},
		unchangedText      : {compute: unchangedText},
		// includes style attribute
		unchangedAttrs     : {compute: unchangedAttrs},
		unchangedChildren  : {compute: unchangedChildren}
	}, function (node, domNodeOrProps) {
		node = node.asTransient();
		if (domNodeOrProps.nodeType) {
			var domNode = domNodeOrProps;
			node = node.domNode.setT(node, domNode);

			var computeFrom = node.asPersistent();
			node = computeFrom.asTransient();

			node = node.type.computeT(node, computeFrom);
			node = node.id.computeT(node);
			node = cachedAttrs.computeT(node);
			node = cachedStyles.computeT(node);

			computeFrom = node.asPersistent();
			node = computeFrom.asTransient();

			node = node.unchangedText.computeT(node, computeFrom);
			node = node.unchangedName.computeT(node, computeFrom);
			node = node.unchangedAttrs.computeT(node, computeFrom);
			node = node.unchangedChildren.computeT(node, computeFrom);

			computeFrom = node.asPersistent();
			node = computeFrom.asTransient();

			node = node.text.computeT(node, computeFrom);
			node = node.name.computeT(node, computeFrom);
			node = node.attrs.computeT(node, computeFrom);
			node = node.children.computeT(node, computeFrom);

		} else if (!Fn.isNou(domNodeOrProps.name)) {
			var props = domNodeOrProps;
			Assert.assertNou(props.text);
			Assert.assertNou(props.nodeType);
			var name = props.name;
			var attrs = props.attrs || {};
			var children = props.children || [];
			node = node.type.setT(node, 1);
			node = node.id.computeT(node);
			node = cachedAttrs.computeT(node);
			node = cachedStyles.computeT(node);

			node = node.unchangedName.setT(node, name);
			node = node.unchangedAttrs.setT(node, attrs);
			node = node.unchangedChildren.setT(node, children);

			node = node.name.setT(node, name);
			node = node.attrs.setT(node, attrs);
			node = node.children.setT(node, children);
		} else if (!Fn.isNou(domNodeOrProps.text)) {
			var props = domNodeOrProps;
			Assert.assertNou(props.name);
			Assert.assertNou(props.nodeType);
			var text = props.text;
			node = node.type.setT(node, 3);
			node = node.unchangedText.setT(node, text);
			node = node.text.setT(node, text);
		}
		return node.asPersistent();
	});
	// attr and style caches are stateful maps only for internal optimization!
	var cachedStyles = Node.addField({compute: Object});
	var cachedAttrs  = Node.addField({compute: Object});

	Maps.extend(Node.prototype, {
		attr         : Accessor.asMethod(Accessor(getAttr, setAttrAffectChanges)),
		style        : Accessor.asMethod(Accessor(getStyle, setStyleAffectChanges)),
		create       : Node,
		updateDom    : Fn.asMethod(updateDom)
	});

	Node.CHANGE_INSERT = CHANGE_INSERT;
	Node.CHANGE_REMOVE = CHANGE_REMOVE;
	Node.CHANGE_REF    = CHANGE_REF;
	Node.CHANGE_REF_AFFINITY_DOM   = CHANGE_REF_AFFINITY_DOM;
	Node.CHANGE_REF_AFFINITY_MODEL = CHANGE_REF_AFFINITY_MODEL;
	Node.AFFINITY_DOM   = AFFINITY_DOM;
	Node.AFFINITY_MODEL = AFFINITY_MODEL;

	function updateDomNodeFromMap(domNode, map, updateFn) {
		Maps.forEach(map, function (value, name) {
			updateFn(domNode, name, value);
		});
	}

	function updateName(node) {
		if (node.name.isMemoized(node)) {
			var name = node.name.get(node);
			var isMemoized = node.unchangedName.isMemoized(node);
			if (!isMemoized || name !== node.unchangedName.get(node)) {
				Assert.notImplemented();
			}
		}
		return node;
	}

	function updateText(node) {
		if (node.text.isMemoized(node)) {
			var text = node.text.get(node);
			if (!node.unchangedText.isMemoized(node)
			    || text !== node.unchangedText.get(node)) {
				var domNode = node.domNode.get(node);
				dom.node.data = text;
				node = node.unchangedText.set(node, text);
			}
		}
		return node;
	}

	function updateFromMapField(node, changedField, cachedField, updateDom) {
		var changedMap = changedField.get(node);
		if (!changedMap) {
			return node;
		}
		var domNode = node.domNode.get(node);
		updateDomNodeFromMap(domNode, changedMap, updateDom);
		node = changedField.set(node, null);
		if (cachedField.isMemoized(node)) {
			var cachedMap = cachedField.get(node);
			cachedMap = Maps.extend({}, cachedMap, changedMap);
			node = cachedField.set(node, cachedMap);
		}
		return node;
	}

	function updateAttrs(node) {
		if (node.unchangedAttrs.isMemoized(node) && node.changedAttrs.get(node)) {
			node = node.unchangedAttrs.set(node, node.attrs.get(node));
		}
		return updateFromMapField(node, node.changedAttrs, cachedAttrs, Dom.setAttr);
	}

	function updateStyles(node) {
		return updateFromMapField(node, node.changedStyles, cachedStyles, Dom.setStyle);
	}

	function createElementNode(doc, node) {
		var name = node.name.get(node);
		var attrs = node.attrs.get(node);
		var domNode = doc.createElement(name);
		updateDomNodeFromMap(domNode, attrs, Dom.setAttr);
		Dom.setAttr(domNode, 'style', node.unchangedAttrs.get(node)['style']);
		var changedStyles = node.changedStyles.get(node);
		updateDomNodeFromMap(domNode, changedStyles, Dom.setStyle);
		return domNode;
	}

	function createTextNode(doc, node) {
		var text = node.text.get(node);
		return doc.createTextNode(text);
	}

	function createDomNode(doc, node) {
		var type = node.type.get(node);
		if (1 === type) {
			return createElementNode(doc, node);
		} else if (3 === type) {
			return createTextNode(doc, node);
		} else {
			Assert.notImplemented()
		}
	}

	// TODO use insertIndex to move elements if a node is
	// being removed in the old tree during a recursive
	// update.
	// TODO support normalized update that will join
	// inserted text nodes and re-use existing text nodes if
	// the content is the same instead of replacing them, so
	// that you can split up Boromir text nodes any way you
	// want and it will not result in changes to the DOM.
	function insertChild(domNode, childNodes, child, i, doc, insertIndex) {
		var refNode = i < childNodes.length ? childNodes[i] : null;
		var childDomNode = createDomNode(doc, child);
		domNode.insertBefore(childDomNode, refNode);
		child = child.domNode.set(child, childDomNode);
		child = updateDomRec(child, doc, insertIndex);
		return child;
	}

	function removeChild(domNode, childNodes, i) {
		domNode.removeChild(childNodes[i]);
	}

	function updateChildren(node, doc, insertIndex) {
		var changedChildren = node.changedChildren.get(node);
		if (!changedChildren) {
			return node;
		}
		var domNode = node.domNode.get(node);
		var childNodes = domNode.childNodes;
		var children = [];
		var i = 0;
		changedChildren.forEach(function (child) {
			var changedInParent = child.changedInParent.get(child);
			var affinity = child.affinity.get(child);
			if (changedInParent & CHANGE_REF_AFFINITY_DOM) {
				if (affinity & AFFINITY_DOM) {
					child = insertChild(domNode, childNodes, child, i, doc, insertIndex);
					i += 1;
				} else {
					removeChild(domNode, childNodes, i);
				}
			} else if (affinity & AFFINITY_DOM) {
				if (changedInParent & CHANGE_INSERT) {
					child = insertChild(domNode, childNodes, child, i, doc, insertIndex);
					i += 1;
				} else if (changedInParent & CHANGE_REMOVE) {
					removeChild(domNode, childNodes, i)
				} else {
					if (changedInParent & CHANGE_REF) {
						child = updateDomRec(child, doc, insertIndex);
					}
					i += 1;
				}
			}
			if (!(changedInParent & CHANGE_REMOVE)) {
				children.push((changedInParent === NO_CHANGE)
				              ? child
				              : child.changedInParent.set(child, NO_CHANGE));
			}
		});
		node = node.children.set(node, children);
		node = node.changedChildren.set(node, null);
		return node;
	}

	function updateDomRec(node, doc, insertIndex) {
		var type = node.type.get(node);
		if (1 === type) {
			node = updateName(node);
			node = updateAttrs(node);
			node = updateStyles(node);
			node = updateChildren(node, doc, insertIndex);
		} else if (3 === type) {
			node = updateText(node);
		} else {
			// Nothing to do for other nodes
		}
		return node;
	}

	function updateDom(node, opts) {
		var domNode = node.domNode.get(node);
		var doc = domNode.ownerDocument;
		Assert.assert(doc, Assert.ELEMENT_NOT_ATTACHED);
		return updateDomRec(node, doc, {});
	}

	return Node;
});
