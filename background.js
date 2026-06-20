// SPDX-FileCopyrightText: 2026 Martijn van der Ven <martijn@vanderven.se>
//
// SPDX-License-Identifier: 0BSD


/** @type {number[]} */
const focusOrder = [];
/** @type {Map<number, {title: string, incognito: boolean, state: string, type: string}>} */
const windowState = new Map();
/** @type {Map<number, boolean>} windowId → visible */
const menuItemState = new Map();
/** @type {string[]} */
let cachedMenuLocations = [];
let cachedExperimental = false;
let menuCreated = false;
let structuralVisible = false;

Promise.all([
	browser.windows.getAll({ windowTypes: ["normal", "popup"] }),
	browser.storage.local.get({
		menu_location: ["all", "tab", "tools_menu"],
		experimental: [],
	}),
]).then(
	([
		windows,
		{
			menu_location: menuLocations,
			experimental: [experimental],
		},
	]) => {
		for (const w of windows) {
			if (w.id !== undefined) {
				windowState.set(w.id, {
					title: w.title ?? "",
					incognito: w.incognito,
					state: w.state ?? "normal",
					type: w.type ?? "normal",
				});
				if (w.focused) focusOrder.unshift(w.id);
			}
		}
		cachedMenuLocations = menuLocations;
		cachedExperimental = !!experimental;
		drawMenus();
	},
);

browser.windows.onCreated.addListener((window) => {
	if ((window.type !== "normal" && window.type !== "popup") || window.id === undefined) return;
	windowState.set(window.id, {
		title: window.title ?? "",
		incognito: window.incognito,
		state: window.state ?? "normal",
		type: window.type,
	});
	reconcileWindowItems();
});
browser.windows.onFocusChanged.addListener((focusedId) => {
	if (focusedId === browser.windows.WINDOW_ID_NONE) return;
	const removeFrom = focusOrder.indexOf(focusedId);
	if (removeFrom !== -1) focusOrder.splice(removeFrom, 1);
	focusOrder.unshift(focusedId);
	const prevInfo = windowState.get(focusOrder[1]);
	const info = windowState.get(focusedId);
	if (info) info.state = "normal";
	if (prevInfo && info && prevInfo.incognito !== info.incognito) {
		drawMenus();
	} else {
		reconcileWindowItems();
	}
	refreshWindowStateIcons();
});
browser.windows.onRemoved.addListener((windowId) => {
	windowState.delete(windowId);
	const removeFrom = focusOrder.indexOf(windowId);
	if (removeFrom !== -1) focusOrder.splice(removeFrom, 1);
	reconcileWindowItems();
});
browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
	browser.tabs.get(tabId).then((tab) => {
		const info = windowState.get(windowId);
		if (!info || !tab.title) return;
		info.title = tab.title;
		browser.menus
			.update(`merge_${windowId}`, {
				title: `Merge tabs from ${tab.title}`,
			})
			.catch(() => {});
		browser.menus
			.update(`merge_into_${windowId}`, {
				title: `... ${tab.title}`,
			})
			.catch(() => {});
	});
});
browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
	if (!changeInfo.title || !tab.active) return;
	const info = windowState.get(tab.windowId);
	if (!info) return;
	info.title = changeInfo.title;
	browser.menus
		.update(`merge_${tab.windowId}`, {
			title: `Merge tabs from ${changeInfo.title}`,
		})
		.catch(() => {});
	browser.menus
		.update(`merge_into_${tab.windowId}`, {
			title: `... ${changeInfo.title}`,
		})
		.catch(() => {});
});
browser.menus.onClicked.addListener((menuItem, currentTab) => {
	const { windowId, id, index } = currentTab ?? {};
	if (windowId === undefined || id === undefined || index === undefined) {
		return;
	}
	if (menuItem.menuItemId === "merge_all") {
		getWindowsForMerge(true).then((windows) =>
			merge(windows.slice(1), windowId, id, index),
		);
	} else if (`${menuItem.menuItemId}`.substr(0, 11) === "merge_into_") {
		const targetWindow = parseInt(`${menuItem.menuItemId}`.substr(11), 10);
		Promise.all([
			browser.tabs.query({ highlighted: true, windowId: windowId }),
			browser.tabs.query({ active: true, windowId: targetWindow }),
		]).then(([tabs, [{ id, index }]]) => {
			if (currentTab && id && index)
				merge(
					[{ tabs: [...new Set(tabs.concat([currentTab]))] }],
					targetWindow,
					id,
					index,
				);
		});
	} else if (`${menuItem.menuItemId}`.substr(0, 6) === "merge_") {
		browser.windows
			.get(parseInt(`${menuItem.menuItemId}`.substr(6), 10), { populate: true })
			.then((subject) => merge([subject], windowId, id, index));
	}
});
browser.commands.onCommand.addListener((command) => {
	if (command === "merge-all-windows") {
		Promise.all([
			browser.tabs.query({ active: true, currentWindow: true }),
			getWindowsForMerge(true),
		]).then(([[{ windowId, id, index }], windows]) => {
			if (windowId && id) merge(windows.slice(1), windowId, id, index);
		});
	} else {
		const targetId = focusOrder[1];
		if (targetId === undefined) return;
		Promise.all([
			browser.tabs.query({ active: true, currentWindow: true }),
			browser.windows.get(targetId, { populate: true }),
		]).then(([[{ windowId, id, index }], window]) => {
			if (windowId && id) merge([window], windowId, id, index);
		});
	}
});

/**
 * Full menu rebuild. Used for initialization and settings changes.
 */
function drawMenus() {
	menuCreated = false;
	structuralVisible = false;
	menuItemState.clear();
	browser.menus.removeAll().then(() => {
		const parentId = "merge-windows-root-menu";
		browser.menus.create({
			id: parentId,
			title: "Merge Windows",
			contexts: cachedMenuLocations,
			visible: false,
		});
		const useExperimental =
			cachedExperimental && cachedMenuLocations.indexOf("tab") !== -1;
		if (useExperimental) {
			browser.menus.create({
				id: "merge-windows-experimental-menu",
				title: "Merge Tab into...",
				contexts: ["tab"],
				visible: false,
			});
		}
		browser.menus.create({
			title: "Merge all windows into this one",
			id: "merge_all",
			parentId,
		});
		browser.menus.create({
			id: "merge-windows-menu-separator",
			type: "separator",
			parentId,
		});
		menuCreated = true;
		reconcileWindowItems();
	});
}

/**
 * Reconcile per-window menu items against desired state.
 * Creates, removes, or toggles visibility with minimal API calls.
 */
function reconcileWindowItems() {
	if (!menuCreated) {
		if (windowState.size >= 2) drawMenus();
		return;
	}

	const focusedId = focusOrder[0];
	const focusedInfo = windowState.get(focusedId);
	const isIncognito = focusedInfo?.incognito;

	// Compute desired visibility for each window
	/** @type {Map<number, boolean>} */
	const desired = new Map();
	for (const [id, info] of windowState) {
		if (isIncognito !== undefined && info.incognito === isIncognito) {
			desired.set(id, id !== focusedId);
		}
	}

	// Remove items for windows that no longer exist or no longer match incognito
	for (const id of menuItemState.keys()) {
		if (!desired.has(id)) {
			browser.menus.remove(`merge_${id}`).catch(() => {});
			browser.menus.remove(`merge_into_${id}`).catch(() => {});
			menuItemState.delete(id);
		}
	}

	// Create or update visibility
	const parentIdTabs =
		cachedExperimental && cachedMenuLocations.indexOf("tab") !== -1
			? "merge-windows-experimental-menu"
			: false;
	for (const [id, visible] of desired) {
		if (menuItemState.has(id)) {
			if (menuItemState.get(id) !== visible) {
				browser.menus.update(`merge_${id}`, { visible }).catch(() => {});
				if (parentIdTabs)
					browser.menus.update(`merge_into_${id}`, { visible }).catch(() => {});
				menuItemState.set(id, visible);
			}
		} else {
			const info = windowState.get(id);
			if (!info) continue;
			const iconVersion = info.state === "minimized" ? "diamonds" : info.type === "popup" ? "app-window" : "blank";
			const icon = `assets/${iconVersion}.svg`;
			browser.menus.create({
				icons: { 16: icon },
				title: `Merge tabs from ${info.title}`,
				id: `merge_${id}`,
				parentId: "merge-windows-root-menu",
				visible,
			});
			if (parentIdTabs)
				browser.menus.create({
					icons: { 16: icon },
					title: `... ${info.title}`,
					id: `merge_into_${id}`,
					parentId: parentIdTabs,
					visible,
				});
			menuItemState.set(id, visible);
		}
	}

	// Toggle structural menu visibility
	const hasVisible = [...desired.values()].some((v) => v);
	if (hasVisible !== structuralVisible) {
		browser.menus.update("merge-windows-root-menu", { visible: hasVisible });
		if (parentIdTabs)
			browser.menus
				.update("merge-windows-experimental-menu", {
					visible: hasVisible,
				})
				.catch(() => {});
		structuralVisible = hasVisible;
	}
}

/**
 * @param {boolean} [excludeMinimized=false] Whether to exclude minimized windows from the result
 * @returns {Promise<ReadonlyArray<browser.windows.Window>>}
 */
async function getWindowsForMerge(excludeMinimized = false) {
	const windows = await browser.windows.getAll({
		windowTypes: ["normal", "popup"],
		populate: true,
	});
	windows.sort((a, b) => {
		const aC = focusOrder.indexOf(a.id ?? NaN) + 1 || Infinity;
		const bC = focusOrder.indexOf(b.id ?? NaN) + 1 || Infinity;
		const r = aC - bC;
		return Number.isNaN(r) ? 0 : r;
	});
	const isIncognito = windows[0].incognito;
	return windows.filter(
		({ id, incognito, state }) =>
			id !== undefined &&
			incognito === isIncognito &&
			(!excludeMinimized || state !== "minimized"),
	);
}

/**
 * @param {ReadonlyArray<Pick<browser.windows.Window, "tabs">>} subjects Array of populated windows.Window objects
 * @param {number} target Window ID to merge all subjects' tabs into
 * @param {number} active Tab ID of the active tab after merge
 * @param {number} activeIndex Index of the active tab
 */
function merge(subjects, target, active, activeIndex) {
	const tabs = subjects.flatMap((window) => window.tabs ?? []);
	Promise.all(
		[browser.storage.local.get({ merge_insertion: ["0"] })].concat(
			tabs
				.filter((tab) => tab.pinned)
				.map((tab) =>
					tab.id
						? browser.tabs.update(tab.id, { pinned: false })
						: Promise.reject(),
				),
		),
	).then(([{ merge_insertion: mergeInsertion }, ...unpinned]) => {
		const moveIndex = mergeInsertion.pop() === "0" ? -1 : ++activeIndex;
		const moveList = tabs.map((tab) => tab.id).filter((id) => id !== undefined);
		if (moveIndex !== -1) moveList.reverse();
		browser.tabs
			.move(moveList, { windowId: target, index: moveIndex })
			.then(() => {
				browser.tabs.update(active, { active: true });
				unpinned.forEach((tab) => {
					browser.tabs.update(tab.id, { pinned: true });
				});
			});
	});
}

/**
 * Refresh window minimize/restore state and update menu icons.
 * Runs asynchronously off the hot path after focus changes.
 */
function refreshWindowStateIcons() {
	browser.windows.getAll({ windowTypes: ["normal", "popup"] }).then((windows) => {
		for (const w of windows) {
			if (w.id === undefined) continue;
			const info = windowState.get(w.id);
			if (!info || info.state === w.state) continue;
			info.state = w.state ?? "normal";
			const iconVersion = info.state === "minimized" ? "diamonds" : info.type === "popup" ? "app-window" : "blank";
			const icon = `assets/${iconVersion}.svg`;
			browser.menus
				.update(`merge_${w.id}`, { icons: { 16: icon } })
				.catch(() => {});
			browser.menus
				.update(`merge_into_${w.id}`, { icons: { 16: icon } })
				.catch(() => {});
		}
	});
}

browser.storage.onChanged.addListener((changes) => {
	if (["menu_location", "experimental"].some((a) => a in changes)) {
		if (changes.menu_location)
			cachedMenuLocations = changes.menu_location.newValue;
		if (changes.experimental)
			cachedExperimental = !!changes.experimental.newValue?.[0];
		drawMenus();
	}
});

browser.runtime.onInstalled.addListener(() => {
	browser.storage.local
		.get(["context_menu_location", "merge_insertion"])
		.then(
			({ context_menu_location: oldLocation, merge_insertion: oldMerge }) => {
				const save = {};
				if (Number.isInteger(oldLocation)) {
					save.menu_location = [["all"], ["tab"], ["all", "tab"]][oldLocation];
					browser.storage.local.remove("context_menu_location");
				}
				if (Number.isInteger(oldMerge)) {
					save.merge_insertion = [oldMerge.toString()];
				}
				browser.storage.local.set(save);
			},
		);
});
