<script setup lang="ts">
import {
    Check,
    HelpCircle,
    MapPin,
    Route,
    Ruler,
    Trash2,
    Waves,
    X,
} from '@lucide/vue';
import L from 'leaflet';
import { computed, nextTick, ref, watch, onMounted, onUnmounted } from 'vue';
import 'leaflet/dist/leaflet.css';
import { Button } from '@/components/ui/button';
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { usePropagation } from '@/composables/usePropagation';
import {
    anchorsIntoRecipe,
    anchorSnaps,
    appendWaypoint,
    controlsInsideRegion,
    cutRouteAt,
    describeAnchorsNeeded,
    describeBlockedControls,
    describeDetached,
    describeFailedSpan,
    describeRectifyRefusal,
    describeRemoveControlBlock,
    describeRemoveWithoutReroute,
    describeRoute,
    describeRouteRefusal,
    describeRouteWarnings,
    describeRoutedPending,
    describeSimplification,
    detachedWaypoints,
    extensionEndpoints,
    finalHeading,
    findVertexForWaypoint,
    headingAtVertex,
    headingBetween,
    insertWaypointAt,
    insertionTarget,
    orderAnchorsByRoute,
    prependTramo,
    prependWaypoint,
    projectOnRoute,
    rebuildRegion,
    removalJoin,
    removeWaypoint,
    replaceTramoSpan,
    simplifyRoutedChain,
    spliceTramo,
    stitchedChain,
    WAYPOINT_LIMIT,
} from '@/lib/guidedRouting';
import type {
    GuideEnd,
    GuideGesture,
    RegionAnchor,
    VertexAddress,
    Waypoint,
} from '@/lib/guidedRouting';
import { consumePreserveToken } from '@/lib/mapView';
import {
    applyDeltaToSelection,
    clampRange,
    decideSnap,
    describeLay,
    describeModeHelp,
    describeRelayHint,
    describeRemoval,
    describeResample,
    describeResampleHint,
    describeSelectionState,
    distanceMeters,
    findClosestSegment,
    insertVertexAt,
    LAY_MAX_CROSSINGS,
    laySelectionAlongStreet,
    projectOnSegment,
    propagationLimitsFor,
    propagateAlongStreet,
    rangeBetween,
    relayLimitsFor,
    relaySelectionOntoNetwork,
    removeVertexAt,
    removeVertices,
    RESAMPLE_SPACING_METERS,
    resampleBlock,
    resampleSelection,
    routeEndpoints,
    snapOptionsFor,
    snapSample,
    verticesWithinBounds,
} from '@/lib/routeEditing';
import type {
    Coordinates,
    Position,
    ResampleSpacing,
    SnapPreset,
    VertexRef,
} from '@/lib/routeEditing';
import {
    continueRoad,
    describeRelay,
    describeSnap,
    lookupRelayStreets,
    lookupRoute,
    lookupSnapStreets,
    SNAP_LOOKUP_TIMEOUT_MS,
} from '@/lib/snapTransport';
import type { SnapLookup } from '@/lib/snapWire';
import {
    canRedo,
    canUndo,
    emptyHistory,
    isTextEntryTarget,
    record,
    redoStep,
    undoStep,
} from '@/lib/undoStack';

import type { History } from '@/lib/undoStack';

/**
 * How many steps of a pending batch are kept.
 *
 * The same figure the page keeps for a line's edits, and bounded by the same
 * thing in practice: a batch holds at most WAYPOINT_LIMIT anchors, so the stack
 * can never be the reason an anchor is unrecallable.
 */
const ANCHOR_UNDO_LIMIT = 50;

const props = defineProps<{
    geoJson: {
        type: 'MultiLineString';
        coordinates: number[][][];
    } | null;
    editable?: boolean;
    mode?: 'move' | 'add' | 'delete' | 'guide';
    /**
     * The control points accepted so far, owned by the parent.
     *
     * The parent is the source of truth â€” they are the state that gets
     * persisted with the route â€” and the map only renders them and asks for
     * changes through the update:guided event. Holding a local copy would
     * make undo restoration a second synchronization problem, and undo is
     * exactly the thing that must restore geometry and controls together.
     */
    guidedWaypoints?: Waypoint[];
    /**
     * How hard a drop is pulled onto the street network.
     *
     * Defaults to normal rather than being required, because this map is also
     * mounted by the route create page, which has no preset control of its own.
     * A required prop would mean every caller has to remember a snapping
     * decision it never offers the user, and a forgotten one is a silently
     * broken editor rather than a type error at runtime.
     */
    snapPreset?: SnapPreset;
    /**
     * Bumped by the parent when a geometry change should not reframe the map.
     *
     * See consumePreserveToken for why this is a counter and not a flag.
     */
    preserveViewToken?: number;
    /**
     * Whether to offer re-laying a selected stretch onto the street network.
     *
     * A prop rather than something every map gets, because the create page has
     * no snap control to sit next to and no preset to take its distance from. A
     * required prop would mean every caller had to make a snapping decision it
     * never offers the user, and a forgotten one is a broken editor rather than
     * a type error.
     */
    relay?: boolean;
    /**
     * Whether to offer re-spacing a selected stretch to even intervals.
     *
     * A prop for the same reason `relay` is one: the create page mounts this map
     * with no controls above it, so a resample control it cannot offer a
     * context for would be a button that appears with nothing to calibrate it.
     */
    resample?: boolean;
    /**
     * The interval a re-spacing is asked for.
     *
     * Defaults to the middle of the table rather than being required, so a
     * caller that turns the feature on without wiring a picker still gets a
     * working action instead of a disabled one nobody can explain.
     */
    resampleSpacing?: ResampleSpacing;
}>();

/**
 * A geometry change is confirmed the moment the mouse comes up, and the snap
 * only refines it afterwards.
 *
 * Committing after the lookup instead would mean the route is not really
 * written down until a network round trip finishes, and every other thing
 * about that is worse than the wait: a drag that starts in the meantime clones
 * geometry that is already stale, and a lookup that never returns leaves the
 * edit uncommitted and the next drag working from the wrong vertices. This
 * counter is what lets a late answer be recognised as late.
 */
let geometryRevision = 0;

const emit = defineEmits<{
    /**
     * The geometry changed, and `meta` says which kind of change it was.
     *
     * Three flags rather than one, because the parent has to treat them
     * differently and a single field could not say what it needed to. `snap` marks
     * a refinement of a drop the reviewer already made, so it is not a history
     * step on its own. `propagated` counts vertices that moved and the reviewer did
     * not drag, which makes it one. `laid` says a whole dragged stretch was laid
     * along a street, which is one even though every vertex it moved was the
     * reviewer's own â€” and which may have removed some of them.
     */
    (
        e: 'update:geoJson',
        value: NonNullable<typeof props.geoJson>,
        meta?: { snap?: boolean; propagated?: number; laid?: boolean },
    ): void;
    /**
     * The re-space interval changed from the toolbar.
     *
     * An emit rather than a local ref, so the stored preference stays the page's
     * business. The picker sits next to the button it governs because reading up
     * to a settings group and back down is how a reviewer ends up re-spacing at
     * the wrong interval, and a local copy of the value would be a second source
     * of truth for the distance the next press will actually use.
     */
    (e: 'update:resampleSpacing', value: ResampleSpacing): void;
    /**
     * A guided action produced its result, and the parent owns both halves.
     *
     * One event rather than two because accepting a tramo is one edit: the
     * geometry splice and the control point that anchors it. The parent
     * records its composite undo entry from the state it held BEFORE this
     * event, so splitting the emit would record a half-state â€” new geometry
     * with old controls â€” between the two.
     *
     * `coordinates` is null when only the control list changed (a first
     * control placed on an empty route, which has no tramo yet).
     */
    (
        e: 'update:guided',
        payload: { coordinates: Coordinates | null; waypoints: Waypoint[] },
    ): void;
    /**
     * Whether a pending-batch step would do anything.
     *
     * Reported rather than held by the page because the batch is the map's:
     * the page owns the history of a saved line and this owns the history of a
     * batch that has not been accepted into one. What the page needs from it is
     * only the answer to "should my Undo button be greyed right now", and a
     * greyed button next to a placed anchor is what made the reviewer conclude
     * that undo did not work.
     */
    (
        e: 'update:pending-undo',
        state: { canUndo: boolean; canRedo: boolean },
    ): void;
}>();

/**
 * The two methods the page's undo and redo buttons need.
 *
 * Exposed rather than emitted because a button has to ASK â€” it cannot take the
 * batch back by wishing, and a boolean told it whether to press would be a
 * second source of truth about what undo will do.
 */
defineExpose({ undoPendingAnchors, redoPendingAnchors });

/**
 * Whether a snap may also pull the vertices around the dropped one onto the same
 * street.
 *
 * Read here rather than passed in, because the map is the only thing that knows
 * how to carry it out and a prop the create page would have to offer a control
 * for is a prop nobody offers a control for. The composable is a plain shared
 * ref, so reading it per drop picks up a change made on the parent without this
 * component needing to be told.
 */
const { propagationEnabled } = usePropagation();

/**
 * What a drop did, once the street lookup has come back.
 *
 * Carries the route, which vertices changed, and where those vertices now are.
 * The last two are not redundant: the count is what the reviewer is told, and
 * the positions are what the markers have to be moved to. A caller that derived
 * one from the other would be re-deriving geometry that already exists.
 */
interface PropagationResult {
    coordinates: Coordinates;
    moved: VertexRef[];
    positions: Map<string, Position>;
}

/** The snap settings in force, or null when snapping is off. */
const snapOptions = computed(() =>
    snapOptionsFor(props.snapPreset ?? 'normal'),
);

const mapContainer = ref<HTMLElement | null>(null);
let map: L.Map | null = null;
let polyline: L.Polyline | null = null;
let vertexMarkers: L.CircleMarker[] = [];

/**
 * Markers addressed by the vertex they stand for, so a drag can move a
 * selection without having to recompute flat-array offsets.
 */
let vertexMarkersByRef = new Map<string, L.CircleMarker>();
let dragCoords: Coordinates | null = null;
let skipNextFitBounds = false;

/**
 * The last preserve-view request the map acted on.
 *
 * Starts equal to the prop's default so the very first render still frames the
 * route: a fresh map has nothing to preserve, it has yet to look at anything.
 */
let lastPreserveToken = 0;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
let endpointMarkers: L.Marker[] = [];

/** Which street a dropped vertex was pulled onto, shown briefly. */
const snapLabel = ref<string | null>(null);
let snapLabelTimer: ReturnType<typeof setTimeout> | null = null;

/** The control points of the guided mode, drawn over the route. */
let guidedMarkers: L.CircleMarker[] = [];

/**
 * The look of a control point: the same dot-and-ring language as a vertex,
 * in amber â€” the colour of a proposal rather than an edit â€” and one size up,
 * because a control is the only thing on the map in this mode and has to read
 * as something you can act on.
 *
 * A selected one fills GREEN, not amber. Green is what "selected" means
 * everywhere else in this editor, and a control filling amber put two colours
 * on two meanings in the same row: amber for "this is the guided mode's
 * business" and amber for "you have picked this one". Fill-not-recolour is the
 * delete mode's own rule, and it is the right one here too.
 */
function guidedMarkerStyle(selected = false): L.CircleMarkerOptions {
    return {
        radius: selected ? 9 : 8,
        color: '#d97706',
        fillColor: selected ? '#16a34a' : '#ffffff',
        fillOpacity: 1,
        weight: 3,
    };
}

function clearGuidedMarkers(): void {
    guidedMarkers.forEach((marker) => map?.removeLayer(marker));
    guidedMarkers = [];
}

/** Repaint the controls' fills for the current selection, without rebuilding. */
function refreshWaypointSelection(): void {
    if (isDragging) {
        return;
    }

    const waypoints = props.guidedWaypoints;

    if (!waypoints?.length) {
        return;
    }

    guidedMarkers.forEach((marker, index) => {
        marker.setStyle(guidedMarkerStyle(selectedWaypoint.value === index));
    });
}

/**
 * Paint the recipe's control points.
 *
 * Called from renderMap rather than only from the waypoint watcher, and that
 * relocation is the fix for a bug this function's own guard used to hide: the
 * watcher does not fire on mount, so a line opened WITH a saved recipe had its
 * controls cleared by renderMap and never painted again, and any edit that
 * changed the geometry without changing the recipe â€” an undo, a re-space, a
 * drag â€” wiped them for the rest of the visit. The map's render owns what is
 * drawn on the map, and a control that disappears when you press Ctrl+Z is a
 * control the reviewer cannot find to delete.
 *
 * Outside guide mode the controls are cleared rather than painted: they belong
 * to that mode's editing, and elsewhere they are dots whose click handler
 * refuses anyway.
 */
function renderGuidedMarkers(): void {
    clearGuidedMarkers();

    const waypoints = props.guidedWaypoints;

    if (
        props.mode !== 'guide' ||
        !props.editable ||
        !map ||
        !waypoints?.length
    ) {
        return;
    }

    waypoints.forEach((waypoint, index) => {
        const marker = L.circleMarker(
            L.latLng(waypoint.position[1], waypoint.position[0]),
            guidedMarkerStyle(selectedWaypoint.value === index),
        );

        // Clicking a control selects it: the row's Remove control is what
        // acts on the selection, per Â§4.5. A click during a pending offer
        // would move state under the thing being judged â€” refused.
        marker.on('click', (e: L.LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(e.originalEvent);

            if (props.mode !== 'guide' || guidedOffer.value !== null) {
                return;
            }

            selectedWaypoint.value =
                selectedWaypoint.value === index ? null : index;
        });

        marker.on('mousedown', (e: L.LeafletMouseEvent) => {
            beginWaypointDrag(marker, index, e);
        });

        marker.addTo(map!);
        guidedMarkers.push(marker);
    });
}

/**
 * Drag one control; the recalculation happens on the drop.
 *
 * The live marker moves under the cursor; nothing is emitted until the mouse
 * comes up, because the recalculation is two chained route searches and a
 * change of mind mid-drag must not leave half of it behind. A press that
 * never moved is a click â€” selection's gesture â€” and the drag is abandoned
 * without touching anything.
 */
function beginWaypointDrag(
    marker: L.CircleMarker,
    index: number,
    e: L.LeafletMouseEvent,
): void {
    if (props.mode !== 'guide' || guidedOffer.value !== null) {
        return;
    }

    L.DomEvent.stopPropagation(e.originalEvent);

    isDragging = true;
    map?.dragging.disable();

    const origin = e.latlng;
    let latest = origin;
    let wasMoved = false;

    const onMouseMove = (move: L.LeafletMouseEvent): void => {
        wasMoved = true;
        latest = move.latlng;
        marker.setLatLng(move.latlng);
    };

    const onMouseUp = (): void => {
        map?.off('mousemove', onMouseMove);
        map?.dragging.enable();
        document.removeEventListener('mouseup', onMouseUp);
        isDragging = false;

        if (!wasMoved) {
            return;
        }

        const dropped: Position = [latest.lng, latest.lat];

        selectedWaypoint.value = null;
        void recalculateMovedWaypoint(index, dropped);
    };

    map?.on('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}

/**
 * The vertices a drag would move.
 *
 * Empty means nothing is selected, which is the state a plain drag starts from
 * for a single vertex and leaves the rest of the route alone.
 */
const selection = ref<VertexRef[]>([]);

/**
 * Where the next shift-click starts a range from.
 *
 * Kept separate from the selection because a range is picked with two clicks
 * and the reviewer needs to be able to change their mind about the second one.
 */
const selectionAnchor = ref<VertexRef | null>(null);

/**
 * True between a vertex drag's mousedown and mouseup.
 *
 * The markers are repainted when the selection changes, and doing that during
 * a drag would remove the layer the drag is bound to out from under it.
 */
let isDragging = false;

/** The rubber band drawn while marquee-selecting, if any. */
let marqueeLayer: L.Rectangle | null = null;

function vertexKey(ref: VertexRef): string {
    return `${ref.segment}:${ref.index}`;
}

function isSelected(ref: VertexRef): boolean {
    return selection.value.some(
        (candidate) =>
            candidate.segment === ref.segment && candidate.index === ref.index,
    );
}

function clearSelection(): void {
    selection.value = [];
    selectionAnchor.value = null;
}

/**
 * Every vertex inside a rectangle, in route order.
 *
 * A marquee is an area gesture and a route is a line, so what it catches is
 * rarely one tidy stretch. Returning the vertices in route order keeps the
 * selection meaningful to look at, and lets the length of it be reported.
 */
function verticesWithin(bounds: L.LatLngBounds): VertexRef[] {
    const coordinates = props.geoJson?.coordinates;

    if (!coordinates) {
        return [];
    }

    return verticesWithinBounds(coordinates, ([lng, lat]) =>
        bounds.contains(L.latLng(lat, lng)),
    );
}

/**
 * Shift-drag on the map background draws a box and selects everything in it.
 *
 * Shift rather than a plain drag because a plain drag pans, and a tool that
 * fights the map for the same gesture is a tool nobody uses. Modifying it is
 * the convention in every editor that has both.
 *
 * Available in delete mode as well as move, because picking a set of vertices
 * and acting on the set is a separate question from what the mode does to one
 * vertex. Excluded in add mode, where a box has no meaning: that mode is about
 * placing vertices, and a selection there would have nothing to select for.
 */
function startMarquee(e: L.LeafletMouseEvent): void {
    if (
        !map ||
        !props.editable ||
        (props.mode ?? 'move') === 'add' ||
        (props.mode ?? 'move') === 'guide'
    ) {
        return;
    }

    // Plain drag on the background pans. Without this guard the marquee
    // swallowed every drag and the map became impossible to move while
    // editing â€” the marquee is the rarer action, so it takes the modifier.
    if (!e.originalEvent.shiftKey) {
        return;
    }

    L.DomEvent.stopPropagation(e.originalEvent);

    isDragging = true;
    map.dragging.disable();

    const origin = e.latlng;

    marqueeLayer = L.rectangle(
        L.latLngBounds(origin, origin) as L.LatLngBounds,
        {
            color: '#16a34a',
            weight: 1,
            fillColor: '#16a34a',
            fillOpacity: 0.12,
            interactive: false,
        },
    ).addTo(map);

    // The document listener is a plain MouseEvent and carries no Leaflet
    // payload, so the last position the map reported is what gets used.
    let latest = origin;

    const onMouseMove = (move: L.LeafletMouseEvent): void => {
        latest = move.latlng;
        marqueeLayer?.setBounds(
            L.latLngBounds(origin, move.latlng) as L.LatLngBounds,
        );
    };

    const onMouseUp = (): void => {
        marqueeLayer?.remove();
        marqueeLayer = null;
        isDragging = false;
        map?.off('mousemove', onMouseMove);
        map?.dragging.enable();
        document.removeEventListener('mouseup', onMouseUp);

        const bounds = L.latLngBounds(origin, latest);

        // A box smaller than a few pixels is a stray shift-click, not a
        // selection, and selecting everything it happens to contain would be a
        // nasty surprise.
        if (!map || map.distance(origin, latest) < 5) {
            return;
        }

        clearSelection();
        selection.value = verticesWithin(bounds);
        refreshMarkerStyles();
    };

    map.on('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}

/**
 * Shift-click: pick a range of vertices, or restart the range.
 *
 * The range is ordered from lower to higher regardless of which end was clicked
 * first, so the direction of the two clicks does not matter.
 */
function selectRangeTo(ref: VertexRef): void {
    const anchor = selectionAnchor.value;

    if (!anchor) {
        selectionAnchor.value = ref;
        selection.value = [ref];

        return;
    }

    const coordinates = props.geoJson?.coordinates;

    if (!coordinates) {
        clearSelection();

        return;
    }

    selection.value = clampRange(coordinates, rangeBetween(anchor, ref));
    selectionAnchor.value = null;
}

/**
 * Shift every selected marker by the same offset.
 *
 * Called on each mousemove while dragging, so it reads the marker's current
 * position and moves it by the frame's delta rather than tracking an absolute
 * target. That keeps the movement exactly in step with the cursor even if a
 * frame is skipped.
 */
function moveMarkers(active: VertexRef[], delta: Position): void {
    for (const ref of active) {
        const marker = vertexMarkersByRef.get(vertexKey(ref));

        if (!marker) {
            continue;
        }

        const current = marker.getLatLng();
        marker.setLatLng(
            L.latLng(current.lat + delta[1], current.lng + delta[0]),
        );
    }
}

/**
 * Put markers at exact positions, keyed by the vertex they stand for.
 *
 * The counterpart to moveMarkers for the vertices a walk placed on a street
 * centreline one at a time. A propagated vertex has no single offset to be moved
 * by â€” each one lands at its own place along the street â€” so the positions are
 * absolute, and this is the one place they can be applied without rebuilding
 * every marker and throwing away the layers a drag may still be bound to.
 */
function setMarkers(positions: Map<string, Position>): void {
    for (const [key, position] of positions) {
        const marker = vertexMarkersByRef.get(key);

        if (!marker) {
            continue;
        }

        marker.setLatLng(L.latLng(position[1], position[0]));
    }
}

function announceSnap(label: string | null): void {
    if (snapLabelTimer) {
        clearTimeout(snapLabelTimer);
    }

    snapLabel.value = label;

    if (label !== null) {
        snapLabelTimer = setTimeout(() => {
            snapLabel.value = null;
        }, 2600);
    }
}

/** What a re-lay did, said in full because it moves vertices nobody dragged. */
const relayLabel = ref<string | null>(null);
let relayLabelTimer: ReturnType<typeof setTimeout> | null = null;

function announceRelay(label: string | null): void {
    if (relayLabelTimer) {
        clearTimeout(relayLabelTimer);
    }

    relayLabel.value = label;

    if (label !== null) {
        // Longer than the snap's own two and a half seconds, because a re-lay
        // reports on a hundred vertices across several streets and reading it
        // takes longer than reading a street name.
        relayLabelTimer = setTimeout(() => {
            relayLabel.value = null;
        }, 9000);
    }
}

/**
 * Whether there is a real route to decorate with endpoint pins.
 *
 * Asked of routeEndpoints rather than re-derived, because the two-position rule
 * is not obvious: it counts across the whole route, not per segment, so a
 * MultiLineString of two one-position segments still gets its two distinct ends.
 * That reasoning lives with the function that implements it, and a second copy
 * of the count here would be a second place to forget it.
 */
const hasGeometry = computed(
    () => routeEndpoints(props.geoJson?.coordinates ?? []) !== null,
);

/**
 * The map container is sized with clamp(400px, 60vh, 700px), so its height
 * changes with the viewport. Leaflet caches the container size and will keep
 * painting tiles at the stale dimensions until invalidateSize() is called,
 * which shows up as grey gaps and misplaced markers. Debounced because
 * invalidateSize() forces a layout read and resize fires rapidly.
 */
function handleWindowResize(): void {
    if (resizeTimer) {
        clearTimeout(resizeTimer);
    }

    resizeTimer = setTimeout(() => {
        map?.invalidateSize();
    }, 150);
}

function updateMapClickListener(
    mode: 'move' | 'add' | 'delete' | 'guide',
): void {
    if (!map) {
        return;
    }

    map.off('click', handleAddVertexClick);
    map.off('click', handleGuidedClick);
    map.off('mousedown', startMarquee);

    if (props.editable && mode === 'add') {
        map.on('click', handleAddVertexClick);
    }

    if (props.editable && mode === 'guide') {
        map.on('click', handleGuidedClick);
    }

    if (props.editable && (mode === 'move' || mode === 'delete')) {
        map.on('mousedown', startMarquee);
    }
}

function handleAddVertexClick(e: L.LeafletMouseEvent): void {
    if (props.mode !== 'add' || !map) {
        return;
    }

    const coordinates = props.geoJson?.coordinates;

    if (!coordinates?.length) {
        const pos: Position = [e.latlng.lng, e.latlng.lat];
        skipNextFitBounds = true;
        emit('update:geoJson', {
            type: 'MultiLineString' as const,
            coordinates: [[pos]],
        });

        return;
    }

    if (coordinates.length === 1 && coordinates[0].length <= 1) {
        const pos: Position = [e.latlng.lng, e.latlng.lat];
        const newCoords = coordinates.map((segment) => [...segment]);
        newCoords[0].push(pos);
        skipNextFitBounds = true;
        emit('update:geoJson', {
            type: 'MultiLineString' as const,
            coordinates: newCoords,
        });

        return;
    }

    const result = findClosestSegment(
        [e.latlng.lng, e.latlng.lat],
        coordinates,
    );

    if (!result) {
        return;
    }

    const { segIdx, pointIdx } = result;
    const a = coordinates[segIdx][pointIdx] as Position;
    const b = coordinates[segIdx][pointIdx + 1] as Position;
    const pos: Position = [e.latlng.lng, e.latlng.lat];

    const projection = projectOnSegment(pos, a, b);
    const closestLatLng = L.latLng(projection.point[1], projection.point[0]);
    const distMeters = map.distance(e.latlng, closestLatLng);

    if (distMeters > 300) {
        return;
    }

    // Prevent adding a new vertex if the click is too close to an existing vertex (within 10 meters)
    const isTooCloseToVertex = coordinates.some((segment) =>
        segment.some((coord) => {
            const vertexLatLng = L.latLng(coord[1], coord[0]);

            return map!.distance(e.latlng, vertexLatLng) < 10;
        }),
    );

    if (isTooCloseToVertex) {
        return;
    }

    skipNextFitBounds = true;
    emit('update:geoJson', {
        type: 'MultiLineString' as const,
        coordinates: insertVertexAt(
            coordinates,
            segIdx,
            pointIdx,
            pos,
            projection.t,
        ),
    });
}

function toLatLngs(coords: Coordinates): L.LatLngTuple[][] {
    return coords.map((segment) =>
        segment.map((coord) => [coord[1], coord[0]] as L.LatLngTuple),
    );
}

/**
 * Draw the start and end pins.
 *
 * Takes the raw coordinates rather than the Leaflet tuples so the endpoint
 * lookup happens in the pure module, on the project's [lng, lat] convention,
 * and the conversion to Leaflet order happens once per pin.
 *
 * Only called in preview mode, and they are read-only and non-interactive, so
 * they can neither occlude a vertex nor swallow a click meant for the map.
 */
function addRouteDecorations(coordinates: Coordinates): void {
    if (!map) {
        return;
    }

    const endpoints = routeEndpoints(coordinates);

    if (!endpoints) {
        return;
    }

    const pin = (position: Position, endpoint: 'start' | 'end'): L.Marker =>
        L.marker(L.latLng(position[1], position[0]), {
            interactive: false,
            keyboard: false,
            icon: endpointIcon(endpoint),
        });

    endpointMarkers.push(
        pin(endpoints.start, 'start').addTo(map),
        pin(endpoints.end, 'end').addTo(map),
    );
}

function endpointIcon(endpoint: 'start' | 'end'): L.DivIcon {
    return L.divIcon({
        className: 'route-endpoint',
        html: `<i data-endpoint="${endpoint}"></i>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
    });
}

function renderMap(): void {
    if (!mapContainer.value) {
        return;
    }

    if (!map) {
        map = L.map(mapContainer.value, {
            zoomControl: true,
            attributionControl: false,
        }).setView([-17.78, -63.18], 12);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
        }).addTo(map);
    }

    clearLayers();

    const coordinates = props.geoJson?.coordinates;

    if (!coordinates?.length) {
        // An empty route still needs its click listener: drawing starts
        // here, in add mode and in guided mode alike. Skipping this bound
        // the listener for the whole visit and the first click did nothing.
        if (props.editable) {
            updateMapClickListener(props.mode ?? 'move');
        }

        // clearLayers() above still took the controls away, and a route with a
        // recipe and no geometry is not a state the page can be in for long â€”
        // but "the marker layer is repainted on every render" has to be true of
        // every render, not the ones that happen to reach the bottom.
        renderGuidedMarkers();

        return;
    }

    const latlngs = toLatLngs(coordinates);

    polyline = L.polyline(latlngs, {
        color: '#3b82f6',
        weight: 4,
        opacity: 0.8,
    }).addTo(map);

    const mode = props.mode ?? 'move';

    if (props.editable) {
        addVertexMarkers(coordinates, latlngs, mode);
        updateMapClickListener(mode);
    } else {
        // Either the route is being edited or it is being looked at, never
        // both. Keeping the pins out of edit mode means they can never occlude
        // a vertex or intercept a click.
        addRouteDecorations(coordinates);
    }

    const preserveView = consumePreserveView();

    if (skipNextFitBounds || preserveView) {
        skipNextFitBounds = false;
    } else {
        map.fitBounds(polyline.getBounds().pad(0.1));
    }

    // Last, and deliberately so: clearLayers() at the top of this render took
    // the control points away with everything else, and this is the render that
    // owns putting them back.
    renderGuidedMarkers();
}

/**
 * Whether the parent asked to keep the current view for exactly this change.
 *
 * Deliberately evaluated even when a drag already claimed this render, because
 * the two are independent one-shots and skipping the evaluation on the short
 * circuit leaves the counter to be spent by whichever change comes next. A
 * reviewer debugging a missing or a duplicate refit would otherwise have to
 * reason about two interleaved pieces of state to find out which one lied.
 */
function consumePreserveView(): boolean {
    const result = consumePreserveToken(
        lastPreserveToken,
        props.preserveViewToken ?? 0,
    );

    lastPreserveToken = result.seen;

    return result.preserve;
}

/**
 * The look of a vertex marker, given what it currently is.
 *
 * Split out from creation so the selection can be repainted with setStyle
 * alone. Recreating the markers on every selection change would work, but it
 * throws away and rebuilds several hundred layers, and it would yank the very
 * marker out from under a drag that is still in progress.
 */
function vertexStyle(
    selected: boolean,
    mode: 'move' | 'add' | 'delete' | 'guide',
): L.CircleMarkerOptions {
    if (mode === 'delete') {
        /**
         * A selected vertex is filled rather than a second colour.
         *
         * Green is what "selected" means everywhere else in this editor, and
         * using it here would put two meanings on one colour. Filling the dot
         * keeps the destructive mode reading as destructive while still showing
         * the selection â€” which it has to, or a box gesture in delete mode looks
         * like it did nothing and the next click removes an unchosen vertex.
         */
        return {
            radius: selected ? 7 : 6,
            color: '#dc2626',
            fillColor: selected ? '#dc2626' : '#ffffff',
            fillOpacity: 1,
            weight: selected ? 3 : 2,
        };
    }

    if (selected) {
        return {
            radius: 7,
            color: '#16a34a',
            fillColor: '#ffffff',
            fillOpacity: 1,
            weight: 3,
        };
    }

    return {
        radius: 6,
        color: '#2563eb',
        fillColor: '#ffffff',
        fillOpacity: 1,
        weight: 2,
    };
}

/**
 * Repaint the markers to match the current selection and mode.
 *
 * Without this, selecting a vertex changed state that nothing could see: the
 * colour is applied when a marker is created, and only a re-render creates
 * markers. A range selection therefore looked like it had done nothing, and
 * the next drag quietly collapsed it back to one vertex.
 */
function refreshMarkerStyles(): void {
    if (isDragging) {
        return;
    }

    const mode = props.mode ?? 'move';

    for (const [key, marker] of vertexMarkersByRef) {
        const selected = selection.value.some((ref) => vertexKey(ref) === key);

        marker.setStyle(vertexStyle(selected, mode));
    }
}

/**
 * One marker per route vertex, for the modes that edit them.
 *
 * Nothing in guide mode. A vertex there is inert â€” the drag and the selection
 * handlers are bound only in move and delete â€” and it sits on top of the exact
 * pixel a control point sits on, so an imported line with nine hundred vertices
 * buries the recipe under nine hundred dots that do nothing. With them gone the
 * dots in this mode ARE the controls, which is the answer to "which of these
 * can I click" without a word of help text.
 */
function addVertexMarkers(
    coords: Coordinates,
    latlngs: L.LatLngTuple[][],
    mode: 'move' | 'add' | 'delete' | 'guide',
): void {
    if (mode === 'guide') {
        return;
    }

    coords.forEach((segment, segIdx) => {
        segment.forEach((_, pointIdx) => {
            const ref: VertexRef = { segment: segIdx, index: pointIdx };

            const marker = L.circleMarker(
                latlngs[segIdx][pointIdx],
                vertexStyle(isSelected(ref), mode),
            );

            if (mode === 'move') {
                beginVertexDrag(marker, ref, coords);

                // Selection lives on click rather than mousedown. Leaflet only
                // fires click when the pointer barely moved, which is exactly
                // the distinction wanted: a shift-click picks a range, a
                // shift-drag moves it.
                marker.on('click', (e: L.LeafletMouseEvent) => {
                    L.DomEvent.stopPropagation(e.originalEvent);

                    if (e.originalEvent.shiftKey) {
                        selectRangeTo(ref);
                    } else {
                        clearSelection();
                        selection.value = [ref];

                        // A plain click anchors a range as well as picking a
                        // vertex, so the gesture a reviewer reaches for is click
                        // the first one then Shift-click the last one. Anchoring
                        // used to be the shift-click's alone, which meant the
                        // range could only be started by holding the modifier â€”
                        // the first Shift was pure ceremony, and the reviewer who
                        // forgot it got a single-vertex selection with no way to
                        // tell which of the two they had done.
                        selectionAnchor.value = ref;
                    }

                    refreshMarkerStyles();
                });
            } else if (mode === 'delete') {
                // Selection lives on click here too, for the same reason it does
                // in move mode: Leaflet only fires click when the pointer barely
                // moved, which is the distinction that lets a shift-click pick a
                // range and a plain click act on one vertex.
                marker.on('click', (e: L.LeafletMouseEvent) => {
                    L.DomEvent.stopPropagation(e.originalEvent);

                    if (e.originalEvent.shiftKey) {
                        selectRangeTo(ref);
                        refreshMarkerStyles();

                        return;
                    }

                    // A plain click still takes that one vertex and nothing else,
                    // which is the whole of what this mode used to do. Deleting a
                    // set is the button's job, not something a bare click should
                    // do to whatever happened to be selected.
                    const newCoords = removeVertexAt(coords, segIdx, pointIdx);

                    // By identity, because that is what a refused removal returns.
                    // It used to be a length check against an empty array, which
                    // meant the primitive handed back a route with nothing on it
                    // and correctness depended on this call remembering to look.
                    if (newCoords === coords) {
                        return;
                    }

                    skipNextFitBounds = true;
                    emit('update:geoJson', {
                        type: 'MultiLineString' as const,
                        coordinates: newCoords,
                    });
                });
            }

            marker.addTo(map!);
            vertexMarkers.push(marker);
            vertexMarkersByRef.set(vertexKey(ref), marker);
        });
    });
}

/**
 * Drag one vertex, carrying the rest of the selection with it.
 *
 * A named function rather than a closure at the bottom of the loop that builds
 * the markers. It was ninety-six lines nested two forEach deep, which is deep
 * enough that the drag lifecycle could not be read as a sequence, and it ended
 * next to the click and delete handlers rather than next to the drop handling
 * it exists to feed.
 *
 * It stays in this file. It reads a dozen pieces of the map's state â€” the drag
 * coordinates, the selection, the marker styling, the polyline â€” and lifting it
 * out would mean handing all of those across as arguments or wrapping them in a
 * context object, which moves the code without clarifying it.
 *
 * The drag's own two flags are declared here rather than per marker, which is
 * what they always were: they are reset on every mousedown, so they describe
 * one drag, not one vertex. A vertex can be dragged any number of times, and
 * the old scope only happened to be harmless.
 */
function beginVertexDrag(
    marker: L.CircleMarker,
    ref: VertexRef,
    coords: Coordinates,
): void {
    marker.on('mousedown', (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e.originalEvent);

        // Shift belongs to the selection, which is handled on click. Starting a
        // drag here as well would mean a shift-click both picks a range and
        // nudges the route.
        if (e.originalEvent.shiftKey) {
            return;
        }

        // Grabbing a vertex that is already selected moves the whole selection.
        // Grabbing an unselected one collapses the selection to it, which is
        // what makes a plain drag always do what the reviewer expects.
        //
        // The anchor moves with it, for the same reason the plain click sets
        // one: where the selection ended up is where a Shift-click extends it
        // from. Anchoring only on click would have made "drag this vertex, then
        // Shift-click that one" reach back to whatever was clicked before the
        // drag â€” an invisible earlier vertex deciding the range.
        if (!isSelected(ref)) {
            clearSelection();
            selection.value = [ref];
            selectionAnchor.value = ref;
            refreshMarkerStyles();
        }

        const active = selection.value.length ? [...selection.value] : [ref];

        // Seeded with the vertex's own position, not zero. The first mousemove
        // computes its delta from here, and starting at the origin of the
        // coordinate space would fling the selection across the map on the
        // first frame of every drag.
        let dropped: Position = [
            coords[ref.segment][ref.index][0],
            coords[ref.segment][ref.index][1],
        ];
        let wasDragged = false;

        isDragging = true;

        if (!dragCoords) {
            dragCoords = structuredClone(coords);
        }

        map?.dragging.disable();

        const onMouseMove = (e: L.LeafletMouseEvent): void => {
            if (!dragCoords) {
                return;
            }

            wasDragged = true;

            const next: Position = [e.latlng.lng, e.latlng.lat];
            const delta: Position = [
                next[0] - dropped[0],
                next[1] - dropped[1],
            ];

            if (delta[0] !== 0 || delta[1] !== 0) {
                dropped = next;
                dragCoords = applyDeltaToSelection(dragCoords, active, delta);
                moveMarkers(active, delta);
                updatePolylinePath();
            }
        };

        const onMouseUp = (event: MouseEvent): void => {
            map?.off('mousemove', onMouseMove);
            map?.dragging.enable();
            document.removeEventListener('mouseup', onMouseUp);
            isDragging = false;

            if (!wasDragged || !dragCoords) {
                dragCoords = null;

                return;
            }

            // The drag ends here and is written down here, before anything is
            // asked of the network. Clearing dragCoords first is what lets the
            // next drag start immediately and from the geometry this one
            // produced, rather than adopting the one still in flight.
            const dragged = dragCoords;

            dragCoords = null;

            const revision = commitDrop(dragged);

            // Alt suppresses the snap for this drop, so a stretch of route can
            // be placed deliberately off the centreline.
            void refineDropAfterSnap(
                dragged,
                active,
                ref,
                dropped,
                event.altKey,
                revision,
            );
        };

        map?.on('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

/**
 * Write a finished drag down, and return the revision it was written at.
 *
 * The revision is what the refinement below checks itself against. It changes
 * on every geometry this component emits, so "has anything else happened since
 * I asked" becomes a comparison instead of a guess.
 */
function commitDrop(coordinates: Coordinates): number {
    skipNextFitBounds = true;

    // Cleared here rather than in the refinement, because a drop that ends up
    // unsnapped still has to take the last drop's message down with it â€” and
    // the refinement is precisely the path that does not run in that case.
    announceSnap(null);
    emit('update:geoJson', {
        type: 'MultiLineString' as const,
        coordinates,
    });

    return ++geometryRevision;
}

/**
 * Pull a committed drop onto a street centreline, and take the rest of the route
 * with it, if the street agrees.
 *
 * The edit is already written by the time this runs, so everything here is
 * optional: a failed, slow or stale lookup costs the refinement and nothing
 * else. That is the whole reason the commit happens first â€” a drop the reviewer
 * made deliberately is never traded away for a network result.
 *
 * The whole selection is sampled, but the result is applied as a rigid offset.
 * The reference vertex decides where the route should sit; the rest of the
 * selection follows it without reshaping, because a stretch of route being
 * dragged across a block is one edit, not N. Sampling all of it is what makes
 * that offset trustworthy â€” it is how the street is chosen, and the choice is
 * made before the offset is computed.
 *
 * The offset only reaches the vertices that were dragged, and that is the gap
 * this second half exists to close: a one-vertex drag onto a street two blocks
 * over leaves its neighbours on the street it came from, so the route crosses
 * the block diagonally and the kink is the reviewer's first sign that the tool
 * did half a job. So once the street is settled, the vertices on either side of
 * the drop are walked onto it â€” forwards and backwards, because a route has a
 * direction of travel and the kink behind a moved vertex is the same defect as
 * the one in front of it.
 *
 * Only ever enabled deliberately, and never when the drop bypassed the snap:
 * holding Alt says the reviewer placed this vertex by hand, and a hand-placed
 * vertex is not an invitation to edit its neighbours either.
 */
async function refineDropAfterSnap(
    coordinates: Coordinates,
    active: VertexRef[],
    reference: VertexRef,
    dropped: Position,
    bypass: boolean,
    revision: number,
): Promise<void> {
    const options = snapOptions.value;

    // Off never reaches the network: there is no threshold to argue about, so
    // asking the server for a street to ignore would be a request per drop
    // whose answer cannot change the outcome.
    if (bypass || !options) {
        return;
    }

    // One deadline for every lookup this drop makes, not one per request. A group
    // move can ask for the street, run out of it and ask what continues, and the
    // timeout is per fetch â€” so two chained lookups would leave the reviewer
    // looking at a committed drop for twice the budget, the second of which has
    // not even started when the first has used it up.
    const deadline = AbortSignal.timeout(SNAP_LOOKUP_TIMEOUT_MS);

    const found = await lookupSnapStreets(
        // The reference alone once the drop is a whole stretch. The other sampled
        // points exist to break a tie between streets at a crossing, and for a
        // group move that tie is between streets the reviewer has just displaced by
        // hand â€” voting with them is asking the drop to agree with itself. It also
        // cannot change the answer: the reference's own distance is what decides
        // whether any street counts.
        active.length > 1
            ? snapSample(coordinates, [], reference, 1)
            : snapSample(coordinates, active, reference),
        options,
        document.cookie,
        deadline,
    );

    // A newer edit landed while this was in flight. Applying the offset now
    // would drag geometry the reviewer has since moved again, by an amount
    // derived from where it used to be â€” so the refinement is dropped and the
    // route stays exactly where they last put it. Checked again after the lay,
    // which awaits its own lookups and can be outlasted the same way.
    if (geometryRevision !== revision || !found) {
        return;
    }

    const decision = decideSnap(found.candidate, { ...options, bypass });

    if (!decision.apply || !decision.position) {
        return;
    }

    const offset: Position = [
        decision.position[0] - dropped[0],
        decision.position[1] - dropped[1],
    ];

    // The snap is applied first and every walk starts from the result, so the
    // reference is already on the centreline when the cursor is placed. Doing it
    // the other way round would start from a point that is off the street and put
    // every vertex it places that same distance off it, which is the rigid offset
    // this is here to replace.
    const snapped = applyDeltaToSelection(coordinates, active, offset);

    // Two tools, chosen by how much was dragged, and the split is a rule rather
    // than a preference.
    //
    // One vertex: the drag moved a point, and what the reviewer wants is for the
    // route to stop kinking around it. That is the propagation's job â€” the
    // neighbours get pulled onto the street and the dragged vertex keeps the
    // position it was dropped at.
    //
    // Two or more: the drag moved a *shape*, and no offset can make that shape
    // lie along a road. The lay replaces the shape with the street's and keeps the
    // spacing, and the propagation would then be reaching for vertices the lay has
    // already placed. Running both is not a stronger version of the same thing; it
    // is two tools writing the same vertices.
    //
    // Both are gated on the same checkbox, because that checkbox already says
    // "snap the nearby points to this street" and a lay is that decision taken for
    // a whole selection instead of for four neighbours. A reviewer who turned it
    // off and then drags a stretch gets a rigid offset and nothing else, which is
    // exactly what they asked for â€” and without the gate they would get thirty
    // vertices moved onto a street they had opted out of.
    if (active.length > 1 && propagationEnabled.value) {
        await laySelection(
            snapped,
            active,
            reference,
            found,
            offset,
            revision,
            deadline,
        );

        return;
    }

    const propagation = spreadAlongStreet(snapped, reference, found.line);

    // The markers follow the snap rather than the raw drop, so the vertex the
    // reviewer sees is the one that was written. The propagated vertices are set
    // absolutely rather than by an offset, because a walk places each one on the
    // centreline at its own distance rather than moving them all by one amount.
    //
    // The order matters and is not interchangeable. A walked vertex can also be
    // in the dragged selection â€” grab the middle of a stretch and the walk
    // reaches the ones either side of it â€” so the two sets overlap. The absolute
    // set has to come second, since it is the one that wins: the geometry below
    // is the snap with the walk applied on top of it, and the markers have to end
    // up matching that rather than the other way round.
    moveMarkers(active, offset);
    setMarkers(propagation.positions);
    announceSnap(describeSnap(found, propagation.moved.length));
    skipNextFitBounds = true;
    emit(
        'update:geoJson',
        {
            type: 'MultiLineString' as const,
            coordinates: propagation.coordinates,
        },
        { snap: true, propagated: propagation.moved.length },
    );
    geometryRevision += 1;
}

/**
 * Lay a dragged stretch along the street its reference vertex snapped to.
 *
 * The continuation lookup is wired in here rather than inside the walk because it
 * is the walk's only network call, and the walk is a pure function: it is handed a
 * callback and a test hands it a fake. This is the only place in the editor where
 * two road lookups are chained, and the revision guard around it is the same one a
 * single drop has â€” a second drag while the lay is in flight makes the answer
 * describe geometry the reviewer has since moved, and applying it would move the
 * stretch to a place nobody dropped it.
 *
 * A lay with nothing placed is not emitted at all. The drag's own result is
 * already on screen and already correct as a drag; a street that turned out to
 * have no usable geometry for it is not a reason to replace that with the drag
 * repeated.
 */
async function laySelection(
    snapped: Coordinates,
    active: VertexRef[],
    reference: VertexRef,
    street: SnapLookup,
    offset: Position,
    revision: number,
    deadline: AbortSignal,
): Promise<void> {
    const lay = await laySelectionAlongStreet(
        snapped,
        active,
        reference,
        street,
        { maxCrossings: LAY_MAX_CROSSINGS },
        (request) =>
            continueRoad(
                request.street,
                request.from,
                request.bearing,
                document.cookie,
                deadline,
            ),
    );

    if (geometryRevision !== revision || lay.placed.length === 0) {
        return;
    }

    // Markers by offset first, then absolutely: the drag left the whole selection
    // where the snap put it and the lay then placed each placed vertex at its own
    // point along the street, so the second set has to win. The vertices the lay
    // dropped keep the marker they have for the frame before the emit lands, which
    // the re-render then clears along with everything else.
    moveMarkers(active, offset);
    setMarkers(
        new Map(
            lay.placed.map((ref) => [
                vertexKey(ref),
                lay.coordinates[ref.segment][ref.index] as Position,
            ]),
        ),
    );

    announceSnap(describeLay(lay));
    skipNextFitBounds = true;

    // `laid` rather than a count, because what the parent needs to know is which
    // kind of move this was and not how big it was. Every vertex a lay places was
    // one the reviewer dragged, so counting them as "propagated" would describe a
    // set of vertices the reviewer never touched â€” and it is dropping one that
    // makes this a second move at all, which is what the history rule turns on.
    emit(
        'update:geoJson',
        {
            type: 'MultiLineString' as const,
            coordinates: lay.coordinates,
        },
        { snap: true, laid: true },
    );
    geometryRevision += 1;
}

/**
 * Walk the vertices either side of a dropped one onto the street it snapped to.
 *
 * Both directions, from the same geometry and over the same input. They cannot
 * collide: each walk only ever touches indices on its own side of the reference,
 * and neither adds nor removes a vertex, so the two index ranges are disjoint
 * and their results can simply be written into one copy of the route.
 *
 * A drop that snapped to a street the response carried no centreline for
 * propagates nothing, which is the same outcome as a reviewer with the feature
 * switched off. That is the right way round: the drop still snapped, and the
 * street it snapped to is on screen either way.
 *
 * Returns the positions as well as the references because the map has to move
 * the markers itself. Leaving that to a re-render would work, and would also
 * clear the selection â€” the same thing it already does after a plain snap, but
 * with three more vertices moved it stops looking like a rounding error.
 */
function spreadAlongStreet(
    coordinates: Coordinates,
    reference: VertexRef,
    line: Coordinates | null,
): PropagationResult {
    const options = snapOptions.value;

    if (!line || !options || !propagationEnabled.value) {
        return { coordinates, moved: [], positions: new Map() };
    }

    const limits = propagationLimitsFor(options.threshold);

    // Backwards first only so the message counts the vertices before the drop
    // before the ones after it, which is the order the reviewer is reading the
    // route in.
    const backward = propagateAlongStreet(
        coordinates,
        reference,
        line,
        -1,
        limits,
    );
    const forward = propagateAlongStreet(
        coordinates,
        reference,
        line,
        1,
        limits,
    );
    const moved: VertexRef[] = [...backward.moved, ...forward.moved];

    if (moved.length === 0) {
        return { coordinates, moved, positions: new Map() };
    }

    const merged = coordinates.map((part) => [...part]);
    const positions = new Map<string, Position>();

    for (const result of [backward, forward]) {
        for (const ref of result.moved) {
            const position = result.coordinates[ref.segment]?.[ref.index];

            if (!position) {
                continue;
            }

            const next: Position = [position[0], position[1]];

            merged[ref.segment][ref.index] = next;
            positions.set(vertexKey(ref), next);
        }
    }

    return { coordinates: merged, moved, positions };
}

function updatePolylinePath(): void {
    if (!polyline || !dragCoords) {
        return;
    }

    polyline.setLatLngs(toLatLngs(dragCoords));
}

/**
 * Re-lay the selected stretch onto the street network.
 *
 * The one action in this editor that reshapes rather than moves, and it is here
 * for a case the other two cannot reach at all: a straight run of points drawn
 * over a road that curves. A drag applies one rigid offset and a propagation
 * walks a few vertices onto a street a single drop chose, so neither can bend a
 * line into a curve however many vertices are selected.
 *
 * Not undoable in a special way. It is an explicit button rather than a
 * refinement of something the reviewer just did, so it is written like any other
 * map edit and the parent's history records it as one step â€” which is the whole
 * safety net, and the reason there is no preview: a hundred vertices moving is
 * large, and one Ctrl+Z is a smaller thing to reason about than a ghost on the
 * map that has to be confirmed.
 *
 * The revision guard is the same one a snap uses. This is a button rather than a
 * drag, so a second press is possible while the first is in flight, and applying
 * a stale answer would move vertices the reviewer has since changed.
 */
async function relaySelection(): Promise<void> {
    const options = snapOptions.value;
    const coordinates = props.geoJson?.coordinates;

    if (!options || !coordinates || selection.value.length < 2) {
        return;
    }

    // Route order before anything else, because the reply is matched by position
    // and a corner is only distinguishable from a straight run by knowing which
    // point came before which. A box gesture has no order of its own.
    const ordered = [...selection.value].sort((a, b) =>
        a.segment !== b.segment ? a.segment - b.segment : a.index - b.index,
    );

    const points = ordered
        .map((ref) => coordinates[ref.segment]?.[ref.index])
        .filter((point): point is number[] => Array.isArray(point))
        .map((point) => [point[0], point[1]] as Position);

    if (points.length < 2) {
        return;
    }

    announceRelay(null);

    const revision = ++geometryRevision;
    const found = await lookupRelayStreets(points, options, document.cookie);

    if (geometryRevision !== revision || found.length === 0) {
        announceRelay('No street was found for the selection.');

        return;
    }

    const result = relaySelectionOntoNetwork(
        coordinates,
        ordered,
        found,
        relayLimitsFor(options.threshold),
    );

    if (result.moved.length === 0) {
        announceRelay(
            describeRelay(result.streets, result.unmatched) ||
                'No street was found for the selection.',
        );

        return;
    }

    setMarkers(
        new Map(
            result.moved.map((ref) => [
                vertexKey(ref),
                [
                    result.coordinates[ref.segment][ref.index][0],
                    result.coordinates[ref.segment][ref.index][1],
                ] as Position,
            ]),
        ),
    );

    announceRelay(describeRelay(result.streets, result.unmatched));
    skipNextFitBounds = true;
    emit('update:geoJson', {
        type: 'MultiLineString' as const,
        coordinates: result.coordinates,
    });
}

/** What a re-spacing did, said in full because it rewrote the vertex list. */
const resampleLabel = ref<string | null>(null);
let resampleLabelTimer: ReturnType<typeof setTimeout> | null = null;

function announceResample(label: string | null): void {
    if (resampleLabelTimer) {
        clearTimeout(resampleLabelTimer);
    }

    resampleLabel.value = label;

    if (label !== null) {
        resampleLabelTimer = setTimeout(() => {
            resampleLabel.value = null;
        }, 9000);
    }
}

// ---------------------------------------------------------------------------
// Guided mode: control points, one routed tramo at a time.
// ---------------------------------------------------------------------------

/** What a pending offer carries, and what accepting it will do. */
interface GuidedOffer {
    /**
     * Extending grows the list at the active frontier; inserting splits a
     * span; removing joints its neighbours' tramo back together. Each kind
     * has its own acceptance geometry, which is why the kind travels with
     * the offer rather than being re-derived at accept time.
     */
    kind: 'extend-tail' | 'extend-head' | 'insert' | 'remove' | 'rectify';
    /** The router answers this offer is made of, in travel order. */
    tramos: Position[][];
    /** Rectification: the anchors' raw clicks, in route order. */
    anchorClicks?: Position[];
    label: string;
    /** Insertion: the waypoint index the new control will take. */
    insertIndex?: number;
    /** Insertion: the span's bounding waypoints, as current vertex addresses. */
    spanFrom?: VertexAddress;
    spanTo?: VertexAddress;
    /** Removal: the waypoint index this offer would take away. */
    removeIndex?: number;
}

const guidedOffer = ref<GuidedOffer | null>(null);

/**
 * Which end a plain away-from-the-route click extends.
 *
 * The tail is the default â€” routes are drawn in their travel order â€” and the
 * toggle flips the frontier so the same gesture can build the route the
 * other way around. Retained only for the visit; the extended route itself
 * does not care which end built it.
 */
const guideFrontier = ref<GuideEnd>('tail');

/**
 * Which gesture a visit to guided mode starts on.
 *
 * Anchors where there is a route to rectify, tracing where there is not: one
 * control can delimit a stretch and zero controls cannot, so a fresh line would
 * answer its first click with "there is no route to rebuild yet" and a reviewer
 * would conclude the mode was broken.
 *
 * A function rather than a constant because the two resets that reach for it —
 * leaving the mode and entering it — have to agree, and a route can be empty on
 * one side of that pair and not the other.
 */
function defaultGuideGesture(): GuideGesture {
    return props.geoJson?.coordinates?.length ? 'anchors' : 'trace';
}

/**
 * Which of the two things a click here can do.
 *
 * The re-lay gesture lives in this field rather than in a pair of toggles: two
 * of them could be live at once, and the row would then name one while the click
 * handler did the other. One field cannot hold a state the row contradicts.
 */
const guideGesture = ref<GuideGesture>(defaultGuideGesture());

/**
 * The anchors placed and not yet accepted, in route order.
 *
 * Local to the map, like the pending preview: they are not part of the recipe
 * until the reviewer accepts the rebuild, so Escape can discard them and a
 * guided mode opened and closed leaves the saved line's recipe untouched.
 * Re-derived from the clicks whenever one is added, because the route itself
 * can move under a batch â€” an undo between two clicks must not leave an anchor
 * ordered by a geometry that no longer exists.
 */
const pendingAnchors = ref<RegionAnchor[]>([]);

/**
 * The badge numbers the last preview could not route between.
 *
 * A report of the LAST preview, not state: it is cleared by any change to the
 * batch (orderPendingClicks) and by a preview that succeeds, because a mark left
 * behind after the reviewer moved an anchor would assert a problem that may no
 * longer exist — and the reviewer would go moving the wrong points.
 */
const failedAnchors = ref<number[]>([]);

/**
 * The batch's own undo stack, over the anchor clicks.
 *
 * The anchors are map-local by design â€” they are not in the recipe until the
 * rebuild is accepted, so Escape can drop them and a guided mode opened and
 * closed leaves the saved line untouched. That is also why they need a stack of
 * their own: without one, Ctrl+Z while a batch was half placed fell through to
 * the page and undid the last edit the reviewer had ACCEPTED, which is the worst
 * possible answer to "take that point back".
 *
 * `History<Position[]>` rather than a second undo implementation, and the
 * payload is the clicks rather than the anchors: the anchors are derived from
 * them (ordered by route, then snapped by the router), so stepping the clicks
 * back re-derives everything that follows.
 */
const anchorHistory = ref<History<Position[]>>(emptyHistory<Position[]>());

let anchorMarkers: L.Marker[] = [];

function clearAnchorMarkers(): void {
    anchorMarkers.forEach((marker) => map?.removeLayer(marker));
    anchorMarkers = [];
}

/** An anchor's badge, numbered by its place on the route rather than by click. */
function anchorIcon(order: number, failed = false): L.DivIcon {
    return L.divIcon({
        className: 'route-anchor',
        html: `<i data-anchor="${order}"${failed ? ' data-failed' : ''}></i><b>${order}</b>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
    });
}

/**
 * The anchors, drawn with their place on the route on them.
 *
 * Draggable, and that is the answer to the reviewer's one complaint about a
 * batch: the router snaps an anchor to the road it finds, so an anchor aimed at
 * a side street can come back sitting on a different one, and the dashed stretch
 * is then not the one that was asked for. Offering "Accept or Reject" alone
 * meant the correction cost the whole batch â€” four anchors to re-place because
 * one snapped badly. Dragging the one that is wrong re-traces the batch in
 * place, and the proposal is still one judgement of Accept or Reject.
 */
function renderPendingAnchors(): void {
    clearAnchorMarkers();

    if (!map) {
        return;
    }

    pendingAnchors.value.forEach((anchor, index) => {
        const position = anchor.snapped ?? anchor.clicked;
        const order = index + 1;
        const marker = L.marker([position[1], position[0]], {
            icon: anchorIcon(order, failedAnchors.value.includes(order)),
            // Interactive for the drag, and for nothing else: a click that
            // reaches the map underneath would place another anchor under the
            // reviewer who is trying to move this one.
            keyboard: false,
            bubblingMouseEvents: false,
        });

        marker.on('mousedown', (e: L.LeafletMouseEvent) => {
            beginAnchorDrag(marker, index, e);
        });

        marker.on('click', (e: L.LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(e.originalEvent);
        });

        marker.addTo(map!);
        anchorMarkers.push(marker);
    });
}

/**
 * One anchor moved; the batch is re-traced in place.
 *
 * The same shape as a control's drag â€” the marker follows the cursor and
 * nothing is emitted until the mouse is up â€” because the recalculation is a
 * router search per leg and a change of mind mid-drag must not leave half of
 * them behind. The drop hands the new click back to the same code that placed
 * it, so the anchor is re-ordered, re-snapped and the preview replaced by one
 * path, and there is no second way for an anchor to be placed that could
 * disagree with the first about where it belongs.
 */
function beginAnchorDrag(
    marker: L.Marker,
    index: number,
    e: L.LeafletMouseEvent,
): void {
    if (props.mode !== 'guide') {
        return;
    }

    L.DomEvent.stopPropagation(e.originalEvent);

    if (pendingAnchors.value.length < 2) {
        // One anchor bounds nothing, so there is nothing to re-trace; moving it
        // would leave the batch exactly as unusable as it was.
        announceGuided(
            'Place a second anchor first: one of them bounds no stretch to rebuild.',
        );

        return;
    }

    isDragging = true;
    map?.dragging.disable();

    const origin = e.latlng;
    let latest = origin;
    let wasMoved = false;

    const onMouseMove = (move: L.LeafletMouseEvent): void => {
        wasMoved = true;
        latest = move.latlng;
        marker.setLatLng(move.latlng);
    };

    const onMouseUp = (): void => {
        map?.off('mousemove', onMouseMove);
        map?.dragging.enable();
        document.removeEventListener('mouseup', onMouseUp);
        isDragging = false;

        if (!wasMoved) {
            // A press that never moved is a click, and the gesture here is
            // removal. Handled in the drag's own mouseup rather than in the
            // marker's click handler because a real drag of five pixels can
            // still make the browser synthesise a click, and that would delete
            // the very anchor being moved.
            removePendingAnchor(index);

            return;
        }

        const dropped: Position = [latest.lng, latest.lat];
        const before = pendingClicks();
        const clicks = [...before];

        clicks[index] = dropped;

        // A stale offer would be a proposal over anchors that no longer exist,
        // and the badge the reviewer just dragged is rebuilt by the re-order.
        dismissPendingPreview();

        if (!orderPendingClicks(clicks)) {
            announceGuided(describeRectifyRefusal('no-route'));

            return;
        }

        recordPendingClicks(before);

        void previewRectify();
    };

    map?.on('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}

/**
 * The batch as the route orders it.
 *
 * Every path that changes the clicks goes through here â€” a new anchor, an anchor
 * dragged somewhere else, one taken away â€” so there is one implementation of
 * "where does this anchor belong" and no second way to place one that could
 * disagree with the first. False means the route is not there to order them
 * against.
 *
 * The clicks, not the anchors: those are what the history stores, and an anchor
 * is this function's output rather than its input.
 */
function orderPendingClicks(clicks: Position[]): boolean {
    const next = orderAnchorsByRoute(clicks, props.geoJson?.coordinates ?? []);

    if (next === null) {
        return false;
    }

    pendingAnchors.value = next;
    // The clicks moved, so whatever the last preview said about these anchors
    // is no longer a statement about them.
    failedAnchors.value = [];
    renderPendingAnchors();

    return true;
}

/** The clicks as they stand, which is the batch's undoable state. */
function pendingClicks(): Position[] {
    return pendingAnchors.value.map((anchor) => anchor.clicked);
}

/** Tell the page what a pending step would do, for its undo button. */
function announcePendingUndo(): void {
    emit('update:pending-undo', {
        canUndo: canUndo(anchorHistory.value),
        canRedo: canRedo(anchorHistory.value),
    });
}

/**
 * Record the batch as it is about to change, so it can come back.
 *
 * Every mutation goes through here, discarding included: Escape dropping three
 * anchors is a change of mind like any other, and "I discarded it, actually
 * leave it" should be one keystroke rather than three clicks and a preview.
 */
function recordPendingClicks(before: Position[]): void {
    anchorHistory.value = record(
        anchorHistory.value,
        before,
        ANCHOR_UNDO_LIMIT,
    );

    announcePendingUndo();
}

/**
 * Take one step back in the batch, or decline.
 *
 * The pending offer goes with it: it is derived from the anchors, and a dashed
 * proposal over anchors that no longer exist is worse than no proposal. The
 * trace is NOT re-run, because that is a router search per leg and an undo is
 * not a request to re-trace â€” the reviewer presses Preview when they want the
 * route back.
 */
function undoPendingAnchors(): boolean {
    const step = undoStep(anchorHistory.value, pendingClicks());

    if (step.value === null) {
        return false;
    }

    anchorHistory.value = step.history;
    dismissPendingPreview();

    if (orderPendingClicks(step.value)) {
        announcePendingUndo();
        announceGuided(
            pendingAnchors.value.length === 0
                ? 'No anchors left. Click the map to place one.'
                : `Step taken back: ${pendingAnchors.value.length} placed. Preview rebuild to trace them.`,
        );
    }

    return true;
}

function redoPendingAnchors(): boolean {
    const step = redoStep(anchorHistory.value, pendingClicks());

    if (step.value === null) {
        return false;
    }

    anchorHistory.value = step.history;
    dismissPendingPreview();

    if (orderPendingClicks(step.value)) {
        announcePendingUndo();
        announceGuided(
            `${pendingAnchors.value.length} placed. Preview rebuild to trace them.`,
        );
    }

    return true;
}

/**
 * One anchor taken out of the batch by clicking it.
 *
 * The surgical correction, and the reason a badge is both draggable and
 * clickable: dragging handles "this snapped onto the wrong street", clicking
 * handles "this one should not be here at all", and step undo handles neither
 * without replaying everything placed before it.
 *
 * The last anchor may go too: that leaves an empty batch, which is where Escape
 * would have left it, one keystroke away from undoing.
 */
function removePendingAnchor(index: number): void {
    const before = pendingClicks();
    const clicks = before.filter((_, i) => i !== index);

    recordPendingClicks(before);
    dismissPendingPreview();

    if (!orderPendingClicks(clicks)) {
        announceGuided(describeRectifyRefusal('no-route'));

        return;
    }

    announceGuided(
        clicks.length === 0
            ? 'Last anchor removed. Click the map to place one.'
            : `Anchor ${index + 1} removed, ${clicks.length} left. Preview rebuild traces them.`,
    );
}

/**
 * One more anchor, placed.
 *
 * The whole list is re-ordered rather than the click appended: an anchor's
 * position in the recipe decides the ordinal the server stores and the role of
 * every control after it, and a reviewer rectifying a route clicks wherever
 * the wrong turn is rather than in travel order.
 *
 * A proposal already on screen does not make this gesture refuse. The batch is
 * the reviewer's, the proposal is derived from it, and a batch that can only be
 * corrected by rejecting and rebuilding from scratch is what made a mis-snapped
 * anchor cost four placements. So a click here re-traces and REPLACES the
 * proposal; never two on screen, because previewRectify() overwrites guidedOffer
 * and the stale layer goes with it.
 */
function addPendingAnchor(clicked: Position): void {
    if (
        pendingAnchors.value.length + (props.guidedWaypoints?.length ?? 0) >=
        WAYPOINT_LIMIT
    ) {
        announceGuided('This route holds too many control points already.');

        return;
    }

    const before = pendingClicks();

    // Captured before anything moves, and dismissed before the re-order rather
    // than after it: orderPendingClicks() returns early when the route cannot
    // order them, and a proposal left alive on that path would be drawn over
    // anchors that no longer exist.
    //
    // The dismissal is also what keeps the offer honest. previewRectify() is
    // async — a router call per leg — so a click followed by an Accept inside
    // that window would run against the PREVIOUS batch's anchorClicks and apply
    // a proposal nobody is looking at, with no error to show for it. Every
    // other path that changes the batch does the same (beginAnchorDrag,
    // removePendingAnchor, undoPendingAnchors); this one used to be the
    // exception.
    const hadOffer = guidedOffer.value !== null;

    if (hadOffer) {
        dismissPendingPreview();
    }

    if (!orderPendingClicks([...before, clicked])) {
        announceGuided(describeRectifyRefusal('no-route'));

        return;
    }

    recordPendingClicks(before);

    if (hadOffer) {
        // The batch changed under the proposal, so the proposal is re-derived
        // from the batch as it now stands. Returns rather than announcing: the
        // re-trace reports its own outcome, and two overlays answering the same
        // click is how a refusal gets buried under a count.
        void previewRectify();

        return;
    }

    const placed = pendingAnchors.value.length;

    announceGuided(
        `Anchor ${placed} placed. ${
            placed < 2
                ? 'Place another to bound the stretch. Escape discards them.'
                : 'Preview rebuilds the stretch between anchor 1 and anchor ' +
                  `${placed}. Escape discards them. Drag one to move it.`
        }`,
    );
}

/**
 * The batch dropped without being remembered, for the states where the batch
 * was never a change of mind: accepted into the recipe, or left behind by
 * leaving the mode.
 *
 * Separate from discardPendingAnchors() because remembering these would make
 * them undoable, and undoing them is wrong in both cases. After an accept the
 * page's own composite entry takes the batch back, which is the edit the
 * reviewer actually made; and a batch from a previous visit to the mode has no
 * business answering a Ctrl+Z in this one, so its history goes with it.
 */
function clearPendingAnchors(): void {
    pendingAnchors.value = [];
    failedAnchors.value = [];
    anchorHistory.value = emptyHistory<Position[]>();
    clearAnchorMarkers();
    announcePendingUndo();
}

/**
 * The batch dropped by Escape, which IS a change of mind and therefore
 * undoable: "I discarded it, actually leave it" should be one keystroke rather
 * than three clicks and a preview.
 *
 * Record-then-empty is the whole of it: the batch is the state being left
 * behind, an empty list is what is on screen next, and undoStep between those
 * two is the keystroke.
 */
function discardPendingAnchors(): void {
    if (pendingAnchors.value.length === 0) {
        return;
    }

    anchorHistory.value = record(
        anchorHistory.value,
        pendingClicks(),
        ANCHOR_UNDO_LIMIT,
    );

    pendingAnchors.value = [];
    clearAnchorMarkers();
    announcePendingUndo();
}

/**
 * A route that moved re-orders the anchors standing on it.
 *
 * Not cosmetic: the batch's legs are chained in this order, so badges left
 * stale by an undo or a vertex drag would trace the stretch backwards and the
 * reviewer would be judging a rebuild of the other direction. The snapped
 * positions follow their own click rather than their slot, since re-ordering
 * moves the slot and not the street.
 */
function reorderPendingAnchors(): void {
    if (pendingAnchors.value.length === 0) {
        return;
    }

    const snappedBy = new Map(
        pendingAnchors.value.map((anchor) => [
            `${anchor.clicked[0]},${anchor.clicked[1]}`,
            anchor.snapped,
        ]),
    );
    const next = orderAnchorsByRoute(
        pendingAnchors.value.map((anchor) => anchor.clicked),
        props.geoJson?.coordinates ?? [],
    );

    if (next === null) {
        // Plain, not remembered: the route they were anchored to is gone, so
        // restoring the batch would only fail to order itself again.
        clearPendingAnchors();
        announceGuided('The route is gone; the anchors with it.');

        return;
    }

    pendingAnchors.value = next.map((anchor) => ({
        ...anchor,
        snapped:
            snappedBy.get(`${anchor.clicked[0]},${anchor.clicked[1]}`) ?? null,
    }));
    renderPendingAnchors();
}

/**
 * The batch's rebuild, offered as one judgement.
 *
 * The legs are chained on the router's own snap rather than on the raw clicks:
 * the second leg starts where the first ended, so two answers cannot disagree
 * about which carriageway of a divided road an anchor belongs to and no kink
 * appears at the join. A leg that comes back refused ends the batch â€” accepting
 * the legs that worked would leave the stretch the reviewer came to fix in
 * place, looking as though it had been fixed.
 */
async function previewRectify(): Promise<void> {
    const coordinates = props.geoJson?.coordinates ?? [];
    const anchors = pendingAnchors.value;
    const waypoints = props.guidedWaypoints ?? [];

    if (anchors.length < 2) {
        announceGuided(describeAnchorsNeeded(anchors.length));

        return;
    }

    const blocked = controlsInsideRegion(waypoints, coordinates, anchors);

    if (blocked.length > 0) {
        announceGuided(describeBlockedControls(blocked));

        return;
    }

    if (waypoints.length + anchors.length > WAYPOINT_LIMIT) {
        announceGuided('This route holds too many control points already.');

        return;
    }

    const revision = ++geometryRevision;

    announceGuided(describeRoutedPending());

    const tramos: Position[][] = [];
    const streets: Array<{ name: string | null; meters: number }> = [];
    const warnings: string[] = [];
    let distance = 0;
    let carried: Position | null = null;
    let dropped = 0;
    let maxDeviation = 0;

    for (let leg = 0; leg < anchors.length - 1; leg += 1) {
        const from = anchors[leg] as RegionAnchor;
        const to = anchors[leg + 1] as RegionAnchor;
        const bearing =
            leg === 0
                ? (headingAtVertex(coordinates, 0, from.index) ??
                  headingBetween(from.clicked, to.clicked))
                : finalHeading([tramos[leg - 1] as Position[]]);

        const found = await lookupRoute(
            carried ?? from.clicked,
            to.clicked,
            bearing,
            document.cookie,
        );

        if (props.mode !== 'guide' || geometryRevision !== revision) {
            return;
        }

        if (
            found === null ||
            found.status !== 'ok' ||
            found.coordinates === null ||
            found.coordinates.length < 2
        ) {
            // Which anchors bound the stretch that failed, named and painted.
            // The reviewer can already move either badge and the drop re-traces
            // on its own, so all this has to do is point at the right two.
            const failure = describeFailedSpan(found?.reason ?? null, leg);

            failedAnchors.value = failure.anchors;
            renderPendingAnchors();
            announceGuided(failure.message);

            return;
        }

        // Simplified per leg, not on the stitched chain: a leg's two ends are an
        // anchor or a join, both of which are control points that must stay
        // vertices, and pinning them is what the helper does with a leg's own
        // ends. Simplifying after stitching would have to recover that structure
        // from the projections again.
        const answer = simplifyRoutedChain(found.coordinates);

        tramos.push(answer.positions);
        streets.push(...(found.streets ?? []));
        warnings.push(...found.warnings);
        distance += found.distanceM ?? 0;
        dropped += answer.dropped;
        maxDeviation = Math.max(maxDeviation, answer.maxDeviation);
        carried = answer.positions[answer.positions.length - 1] as Position;
    }

    // The anchors move onto the roads the router put them on, so the badges
    // show where they will be committed rather than where they were clicked.
    const snaps = anchorSnaps(tramos);

    pendingAnchors.value = anchors.map((anchor, index) => ({
        ...anchor,
        snapped: snaps[index] ?? anchor.snapped,
    }));
    // Every leg routed, so whatever the previous preview said about these
    // anchors is now out of date in the other direction too. Cleared BEFORE the
    // repaint, which is the whole reason this is a separate line rather than
    // something orderPendingClicks already did.
    failedAnchors.value = [];

    renderPendingAnchors();

    guidedOffer.value = {
        kind: 'rectify',
        tramos,
        anchorClicks: pendingAnchors.value.map((anchor) => anchor.clicked),
        label:
            describeRoute(streets, distance) +
            describeRouteWarnings(warnings) +
            describeSimplification(dropped, maxDeviation),
    };

    announceGuided(
        `${guidedOffer.value.label}. Accept to rebuild the stretch, or Reject to keep the route as it is.`,
    );
    renderGuidedPreview();
}

/**
 * The control point selected by clicking its marker, if any.
 *
 * Selection is what makes an interior control removable (Â§4.5): the row
 * gains a "Remove control" while a selection lives, and the preview of the
 * joined tramo is what the reviewer confirms.
 */
const selectedWaypoint = ref<number | null>(null);

/** What the guided mode last did or refused, said in the overlay. */
const guidedLabel = ref<string | null>(null);
let guidedLabelTimer: ReturnType<typeof setTimeout> | null = null;

function announceGuided(label: string | null): void {
    if (guidedLabelTimer) {
        clearTimeout(guidedLabelTimer);
    }

    guidedLabel.value = label;

    if (label !== null) {
        guidedLabelTimer = setTimeout(() => {
            guidedLabel.value = null;
        }, 9000);
    }
}

let guidedLayers: L.Polyline[] = [];

function clearGuidedLayer(): void {
    guidedLayers.forEach((layer) => map?.removeLayer(layer));
    guidedLayers = [];
}

function renderGuidedPreview(): void {
    clearGuidedLayer();

    const offer = guidedOffer.value;

    if (!map || !offer) {
        return;
    }

    for (const tramo of offer.tramos) {
        guidedLayers.push(
            L.polyline(
                tramo.map((position) => L.latLng(position[1], position[0])),
                {
                    color: '#f59e0b',
                    weight: 4,
                    opacity: 0.9,
                    dashArray: '8 6',
                },
            ).addTo(map),
        );
    }
}

/** The last control's position, or null with nothing to route from. */
function lastGuidedPosition(waypoints: Waypoint[]): Position | null {
    const last = waypoints[waypoints.length - 1];

    return last ? [last.position[0], last.position[1]] : null;
}

/** The first control's position â€” the end a head extension grows from. */
function firstGuidedPosition(waypoints: Waypoint[]): Position | null {
    const first = waypoints[0];

    return first ? [first.position[0], first.position[1]] : null;
}

/**
 * A click in guided mode: place a control point, then route to it.
 *
 * Three questions answer in order. Nothing behind the click starts the list.
 * A hand-drawing session places the vertex straight out. And a click that
 * lands on a span the recipe owns is an insertion â€” split that span â€” while
 * everything else extends the route from the active frontier. Spec Â§2: the
 * system proposes, the user decides; Â§4: the existing recipe is editable at
 * its own points.
 *
 * The revision guard is the same one a drop's refinement uses: a click
 * while a route search is in flight is a change of mind, and applying a
 * stale answer would draw a tramo for a control point nobody kept.
 */
async function handleGuidedClick(e: L.LeafletMouseEvent): Promise<void> {
    if (props.mode !== 'guide' || !map) {
        return;
    }

    const clicked: Position = [e.latlng.lng, e.latlng.lat];

    if (guideGesture.value === 'anchors') {
        addPendingAnchor(clicked);

        return;
    }

    // Past the anchors branch on purpose: a batch is editable while its proposal
    // is up, and addPendingAnchor() re-traces it, so a click there adds a point
    // rather than replacing the thing being judged. In trace the click IS the
    // next tramo, and letting it through would put a second proposal on screen
    // over the first one.
    if (guidedOffer.value !== null) {
        return;
    }

    const waypoints = props.guidedWaypoints ?? [];
    const from =
        guideFrontier.value === 'tail'
            ? lastGuidedPosition(waypoints)
            : firstGuidedPosition(waypoints);

    if (from === null) {
        // First control, nothing behind it. The position is the raw click:
        // only the router's answer knows the road, and there is no answer
        // to take a position from yet.
        emitGuided(null, [{ position: clicked, role: 'start' }]);
        announceGuided(
            'Control point placed. Click the next one to trace the tramo.',
        );

        return;
    }

    if (waypoints.length >= WAYPOINT_LIMIT) {
        announceGuided('This route holds too many control points already.');

        return;
    }

    if (guideFrontier.value === 'tail') {
        const target = insertionTarget(
            props.geoJson?.coordinates ?? [],
            props.guidedWaypoints ?? [],
            clicked,
        );

        if (target !== null) {
            await offerInsertion(clicked, waypoints, target);

            return;
        }
    }

    await offerExtension(clicked, waypoints, from);
}

/**
 * Two chained route calls for an insertion, offered as one judgement.
 *
 * The first tramo runs from the span's start bound to the click, leaving
 * with the heading the route arrives at that bound with; the second runs
 * from the click to the end bound with the FIRST answer's arrival heading â€”
 * chained, so a detour's second half leaves pointing where the detour
 * came back from. Both or neither: an offer that splits a span but cannot
 * join the other side would leave the recipe describing a route it does
 * not draw.
 */
async function offerInsertion(
    clicked: Position,
    waypoints: Waypoint[],
    target: { from: VertexAddress; to: VertexAddress; insertIndex: number },
): Promise<void> {
    const coordinates = props.geoJson?.coordinates ?? [];
    const from = waypoints[target.insertIndex - 1].position;
    const to = waypoints[target.insertIndex].position;

    announceGuided(describeRoutedPending());

    const firstRevision = ++geometryRevision;
    const first = await lookupRoute(
        from,
        clicked,
        headingAtVertex(coordinates, target.from.segment, target.from.index) ??
            headingBetween(from, clicked),
        document.cookie,
    );

    if (props.mode !== 'guide' || geometryRevision !== firstRevision) {
        return;
    }

    if (first === null || first.status !== 'ok' || first.coordinates === null) {
        announceGuided(describeRouteRefusal(first?.reason ?? null));

        return;
    }

    const second = await lookupRoute(
        clicked,
        to,
        finalHeading([first.coordinates]),
        document.cookie,
    );

    if (props.mode !== 'guide' || geometryRevision !== firstRevision) {
        return;
    }

    if (
        second === null ||
        second.status !== 'ok' ||
        second.coordinates === null
    ) {
        announceGuided(describeRouteRefusal(second?.reason ?? null));

        return;
    }

    const streets = [...(first.streets ?? []), ...(second.streets ?? [])];
    const firstLeg = simplifyRoutedChain(first.coordinates);
    const secondLeg = simplifyRoutedChain(second.coordinates);

    guidedOffer.value = {
        kind: 'insert',
        tramos: [firstLeg.positions, secondLeg.positions],
        insertIndex: target.insertIndex,
        spanFrom: target.from,
        spanTo: target.to,
        label:
            describeRoute(
                streets,
                (first.distanceM ?? 0) + (second.distanceM ?? 0),
            ) +
            describeRouteWarnings([...first.warnings, ...second.warnings]) +
            describeSimplification(
                firstLeg.dropped + secondLeg.dropped,
                Math.max(firstLeg.maxDeviation, secondLeg.maxDeviation),
            ),
    };

    announceGuided(
        `${guidedOffer.value.label}. Accept to split the tramo, or Reject.`,
    );
    renderGuidedPreview();
}

async function offerExtension(
    clicked: Position,
    waypoints: Waypoint[],
    from: Position,
): Promise<void> {
    const atHead = guideFrontier.value === 'head';
    const { origin, destination } = extensionEndpoints(
        guideFrontier.value,
        from,
        clicked,
    );

    // The tail extends with the heading the route arrives with; the head
    // extends from empty air, and the nearest thing to an intent the click
    // carries is the straight line it aims at the route with â€” which is also
    // the approach the snap should be looking for, now that the head's origin
    // IS the click.
    const bearing = atHead
        ? headingBetween(clicked, from)
        : finalHeading(props.geoJson?.coordinates ?? null);

    const revision = ++geometryRevision;

    announceGuided(describeRoutedPending());

    const found = await lookupRoute(
        origin,
        destination,
        bearing,
        document.cookie,
    );

    if (props.mode !== 'guide' || geometryRevision !== revision) {
        return;
    }

    if (found === null || found.status !== 'ok' || found.coordinates === null) {
        guidedOffer.value = null;
        announceGuided(describeRouteRefusal(found?.reason ?? null));

        return;
    }

    const simplified = simplifyRoutedChain(found.coordinates);

    guidedOffer.value = {
        kind: atHead ? 'extend-head' : 'extend-tail',
        tramos: [simplified.positions],
        label:
            describeRoute(found.streets ?? [], found.distanceM) +
            describeRouteWarnings(found.warnings) +
            describeSimplification(simplified.dropped, simplified.maxDeviation),
    };
    announceGuided(
        `${guidedOffer.value.label}. Accept, or Reject to draw it yourself.`,
    );
    renderGuidedPreview();
}

/** One guided event out, with roles derived from the position in the list. */
function emitGuided(
    coordinates: Coordinates | null,
    waypoints: Waypoint[],
): void {
    emit('update:guided', { coordinates, waypoints });
}

function acceptPreview(): void {
    const offer = guidedOffer.value;
    const waypoints = props.guidedWaypoints ?? [];

    if (!offer || waypoints.length === 0) {
        return;
    }

    const coordinates = props.geoJson?.coordinates ?? [];

    switch (offer.kind) {
        case 'extend-tail': {
            const tramo = offer.tramos[0];
            const freshRoute = waypoints.length === 1;

            // On the first tramo the start control takes the router's own
            // origin: the waypoint was placed on a raw click, the tramo
            // starts where the network actually begins, and a control that
            // sits off its own route is the disagreement a persisted record
            // must not carry.
            const accepted = appendWaypoint(
                freshRoute
                    ? [{ position: tramo[0], role: 'start' as const }]
                    : waypoints,
                tramo[tramo.length - 1],
            );

            emitGuided(spliceTramo(coordinates, tramo), accepted);

            break;
        }

        case 'extend-head': {
            const tramo = offer.tramos[0];

            // The answer arrives new point -> the start the route already had
            // (see extensionEndpoints), so its head is the new control and its
            // tail is the join prependTramo drops. Reversing it here is the bug
            // that sent the route back to its own origin.
            emitGuided(
                prependTramo(coordinates, tramo),
                prependWaypoint(waypoints, tramo[0]),
            );

            break;
        }

        case 'insert': {
            const tramos = offer.tramos;

            if (
                offer.spanFrom === undefined ||
                offer.spanTo === undefined ||
                offer.insertIndex === undefined
            ) {
                return;
            }

            // The bounds may have moved since the offer was made (an undo,
            // another edit); re-derived rather than trusted.
            const from = findVertexForWaypoint(
                coordinates,
                waypoints[offer.insertIndex - 1],
            );
            const to = findVertexForWaypoint(
                coordinates,
                waypoints[offer.insertIndex],
            );

            if (from === null || to === null || to.index <= from.index) {
                announceGuided(describeRouteRefusal(null));

                return;
            }

            emitGuided(
                replaceTramoSpan(coordinates, from, to, [
                    ...tramos[0],
                    ...tramos[1].slice(1),
                ]),
                insertWaypointAt(
                    waypoints,
                    offer.insertIndex,
                    tramos[0][tramos[0].length - 1],
                ),
            );

            break;
        }

        case 'remove': {
            const tramo = offer.tramos[0];

            if (
                offer.removeIndex === undefined ||
                offer.spanFrom === undefined ||
                offer.spanTo === undefined
            ) {
                return;
            }

            const next = removeWaypoint(waypoints, offer.removeIndex);

            if (next === null) {
                return;
            }

            // Spec Â§4.5's confirmation is this acceptance: the joined tramo
            // was shown dashed and the reviewer pressed Accept on it.
            emitGuided(
                replaceTramoSpan(
                    coordinates,
                    offer.spanFrom,
                    offer.spanTo,
                    tramo,
                ),
                next,
            );

            break;
        }

        case 'rectify': {
            const clicks = offer.anchorClicks ?? [];

            // Re-derived from the clicks, never from the offer's own projections: the
            // boundaries are vertex addresses into whatever geometry exists when
            // the reviewer accepts, and a stored one is only right for the
            // geometry it was cut against.
            const ordered = orderAnchorsByRoute(clicks, coordinates);

            if (ordered === null) {
                announceGuided(describeRectifyRefusal('no-route'));

                return;
            }

            const blocked = controlsInsideRegion(
                waypoints,
                coordinates,
                ordered,
            );

            if (blocked.length > 0) {
                announceGuided(describeBlockedControls(blocked));

                return;
            }

            const snaps = anchorSnaps(offer.tramos);
            const region = ordered.map((anchor, index) => ({
                ...anchor,
                snapped: snaps[index] ?? null,
            }));
            const rebuilt = rebuildRegion(
                coordinates,
                region,
                stitchedChain(offer.tramos),
            );

            if (!rebuilt.rebuilt) {
                announceGuided(describeRectifyRefusal(rebuilt.reason));

                return;
            }

            emitGuided(
                rebuilt.coordinates,
                anchorsIntoRecipe(waypoints, coordinates, region),
            );

            clearPendingAnchors();
            guideGesture.value = defaultGuideGesture();

            break;
        }
    }

    guidedOffer.value = null;
    clearGuidedLayer();
    announceGuided('Applied. Click the next control, or finish when done.');
}

function rejectPreview(): void {
    guidedOffer.value = null;
    clearGuidedLayer();
    announceGuided(
        'Preview dismissed. Click again to re-trace, or draw by hand.',
    );
}

/**
 * Pick the gesture the next click performs.
 *
 * Takes the target rather than flipping, because the three buttons name the
 * state they lead to and a click that lands somewhere other than its label
 * promises is the confusion this replaced. Re-picking the gesture already
 * active changes nothing, and a pending batch survives the switch: a reviewer
 * who pins three anchors and then wants to look at the route in move mode has
 * not thrown their work away, and the anchors are not in the recipe until a
 * rebuild is accepted.
 */
function setGuideGesture(gesture: GuideGesture): void {
    if (guideGesture.value === gesture) {
        return;
    }

    guideGesture.value = gesture;

    if (gesture === 'anchors') {
        announceGuided(
            'Placing anchors. Click the map to pin them; two bound the stretch to rebuild.',
        );
    }
}

/**
 * The two gestures, as the row offers them.
 *
 * Declared here rather than written out twice so the buttons, their order and
 * the state they set cannot drift apart â€” and rendered through `component :is`,
 * because the icon is the only thing that differs and two fixed buttons are one
 * thing to remember.
 */
const GUIDE_GESTURES: Array<{
    id: GuideGesture;
    label: string;
    icon: typeof Route;
}> = [
    // The order is the order of the answer, not alphabetical: the first entry is
    // the one a visit starts on for a route with geometry, and a row that lists
    // its default second is making the reviewer hunt for where it left off.
    { id: 'anchors', label: 'Anchors', icon: MapPin },
    { id: 'trace', label: 'Trace', icon: Route },
];

/** Why the removal control is disabled right now, or '' when it is live. */
const removeControlBlock = computed(() =>
    describeRemoveControlBlock(selectedWaypoint.value),
);

/**
 * Whether removing the selected control can re-route the tramo it joined.
 *
 * The label follows this, because "Remove control" followed by no preview at
 * all reads as the editor losing the offer â€” and the reviewer has no way to
 * tell that apart from a button that is broken. Saying "Remove only" states the
 * outcome before the press, which is the only moment at which it is useful.
 *
 * The rule is removalJoin()'s, not this computed's: the press answers the same
 * question from the same function, and a label computed any other way is a
 * promise waiting to be broken.
 */
const removeReroutes = computed(() => {
    const index = selectedWaypoint.value;

    if (index === null) {
        return false;
    }

    return (
        removalJoin(
            props.geoJson?.coordinates ?? [],
            waypointsForGuide.value,
            index,
        ) !== null
    );
});

/**
 * Pick the end the next click grows.
 *
 * Takes the target rather than flipping, because the two buttons say where
 * they will take it and a click that lands somewhere else than its label
 * promises is the confusion this replaced. Re-picking the end already active
 * announces nothing: there is no change to report.
 */
function setGuideFrontier(end: GuideEnd): void {
    if (guideFrontier.value === end) {
        return;
    }

    guideFrontier.value = end;

    announceGuided(
        end === 'head'
            ? 'Extending at the start of the route.'
            : 'Extending at the end of the route.',
    );
}

/** A stale preview is dismissed; a manual choice survives it. */
function dismissPendingPreview(): void {
    if (guidedOffer.value !== null) {
        guidedOffer.value = null;
        clearGuidedLayer();
    }
}

/** Leaving guided mode takes the pending preview and the manual switch with it. */
/**
 * Leaving guided mode takes the pending preview, the anchors, the manual switch
 * and the control markers with it.
 *
 * The markers are in that list because a mode change never reaches renderMap,
 * which is where they are painted: without this, walking out of guided mode
 * left a route wearing the control points of a mode the reviewer had just left,
 * over the vertex markers of the one they were in.
 */
function cancelPendingPreview(): void {
    dismissPendingPreview();
    clearPendingAnchors();
    clearGuidedMarkers();
    guideGesture.value = defaultGuideGesture();
    guideFrontier.value = 'tail';
    selectedWaypoint.value = null;
}

/** The recipe as a computed, for the template and the drag handlers. */
const waypointsForGuide = computed<Waypoint[]>(
    () => props.guidedWaypoints ?? [],
);

/**
 * How many accepted controls no longer sit on their route, for the Â§3 pill.
 *
 * Computed rather than announced-once because the state it describes is
 * derived: it changes under hand edits of the geometry and returns when the
 * tramo is retraced. A pill that said it once and forgot would lie about the
 * visit's actual state.
 */
const detachedCount = computed(
    () =>
        detachedWaypoints(
            props.geoJson?.coordinates ?? [],
            waypointsForGuide.value,
        ).length,
);

/** The Â§3 sentence for the detached count, or '' when there is nothing to say. */
const detachedText = computed(() => describeDetached(detachedCount.value));

// ---------------------------------------------------------------------------
// Spec Â§4.3: moving a control recalculates its two adjacent tramos.
// ---------------------------------------------------------------------------

/**
 * Where a control meets the route, and the geometry that meeting needs.
 *
 * Its own vertex when it still has one, and the point it PROJECTS onto when it
 * has drifted off â€” which is the whole answer to a control that cannot be
 * moved. The drag used to look for the vertex alone, so a control thirty metres
 * off its route had no span to replace, the drag refused, and the row's tooltip
 * was telling the reviewer to drag it. A route where the geometry was hand
 * edited away from its own recipe is a normal state, not an exotic one, and the
 * projection is what makes a control in it editable at all: the stretch it used
 * to pin can be delimited by where it lands instead of by a vertex it has lost.
 *
 * The coordinates come back with it because a projection may write a vertex, and
 * an index read before that write points one vertex too far along.
 */
function waypointBound(
    coordinates: Coordinates,
    waypoint: Waypoint,
): { coordinates: Coordinates; address: VertexAddress } | null {
    const vertex = findVertexForWaypoint(coordinates, waypoint);

    if (vertex !== null) {
        return { coordinates, address: vertex };
    }

    const projection = projectOnRoute(coordinates, waypoint.position);

    if (projection === null) {
        return null;
    }

    const cut = cutRouteAt(coordinates, projection);

    return cut === null
        ? null
        : {
              coordinates: cut.coordinates,
              address: {
                  segment: 0,
                  index: cut.index,
                  distance: distanceMeters(waypoint.position, projection.point),
              },
          };
}

/**
 * A dropped control, recalculated.
 *
 * The two adjacent tramos are the only ones allowed to change (spec Â§4.3),
 * and they are recalculated CHAINED on purpose: the arriving tramo runs to
 * where the control was dropped and the waypoint takes that answer's on-road
 * end, then the departing tramo leaves from THAT position â€” so both halves
 * agree on where the control is, instead of two searches snapping it to two
 * different nodes and the route splitting at its own control.
 *
 * Either side may refuse (Â§3): it keeps its old geometry and the warning is
 * the honest outcome â€” the state emitted is whatever actually happened,
 * partial included, because undo restores it all the same.
 */
async function recalculateMovedWaypoint(
    index: number,
    position: Position,
): Promise<void> {
    const waypoints = waypointsForGuide.value;
    const coordinates = props.geoJson?.coordinates ?? [];

    if (waypoints[index] === undefined || waypoints.length < 2) {
        // A lone control has no tramos; the move is the whole edit.
        emitGuided(
            null,
            waypoints.map((waypoint, i) =>
                i === index ? { position, role: waypoint.role } : waypoint,
            ),
        );

        return;
    }

    const revision = ++geometryRevision;

    announceGuided(describeRoutedPending());

    let workingCoordinates = coordinates;
    let workingWaypoints = waypoints;
    const failed: string[] = [];
    let dropped = 0;
    let maxDeviation = 0;

    /** One adjacent tramo, simplified on the way in and counted on the way past. */
    const answerOf = (raw: Position[]): Position[] => {
        const answer = simplifyRoutedChain(raw);

        dropped += answer.dropped;
        maxDeviation = Math.max(maxDeviation, answer.maxDeviation);

        return answer.positions;
    };

    if (index > 0) {
        const previous = waypoints[index - 1];
        const previousBound = waypointBound(workingCoordinates, previous);
        const movedBound = waypointBound(workingCoordinates, waypoints[index]);

        if (previousBound === null || movedBound === null) {
            failed.push('there is no route for the tramo behind it to follow');
        } else if (movedBound.address.index <= previousBound.address.index) {
            // Also the guard that keeps the indices honest: a cut writes a
            // vertex and renumbers everything after it, so a bound at or before
            // the other one is refused rather than spliced one vertex too far.
            failed.push(
                'the tramo behind it is degenerate: the two controls sit in ' +
                    'the other order along the route. Remove it, or drag it ' +
                    'between them.',
            );
        } else {
            const arrivalHeading =
                headingAtVertex(
                    workingCoordinates,
                    previousBound.address.segment,
                    previousBound.address.index,
                ) ?? headingBetween(previous.position, position);

            const tramo = await lookupRoute(
                previous.position,
                position,
                arrivalHeading,
                document.cookie,
            );

            if (props.mode !== 'guide' || geometryRevision !== revision) {
                return;
            }

            if (
                tramo === null ||
                tramo.status !== 'ok' ||
                tramo.coordinates === null
            ) {
                failed.push(describeRouteRefusal(tramo?.reason ?? null));
            } else {
                // The span behind the moved control disappears whole: the
                // answer now runs to where the control was dropped, and the
                // waypoint takes that on-road end as its position.
                const movedEnd =
                    tramo.coordinates[tramo.coordinates.length - 1];

                workingCoordinates = replaceTramoSpan(
                    movedBound.coordinates,
                    previousBound.address,
                    movedBound.address,
                    answerOf(tramo.coordinates),
                );

                workingWaypoints = workingWaypoints.map((waypoint, i) =>
                    i === index
                        ? {
                              position: movedEnd,
                              role: waypoint.role,
                          }
                        : waypoint,
                );
            }
        }
    }

    if (index < waypoints.length - 1) {
        const next = workingWaypoints[index + 1];
        const origin = workingWaypoints[index];
        const originBound = waypointBound(workingCoordinates, origin);

        if (originBound === null) {
            failed.push('there is no route for the tramo ahead to follow');
        } else {
            const departureHeading =
                headingAtVertex(
                    workingCoordinates,
                    originBound.address.segment,
                    originBound.address.index,
                ) ?? headingBetween(origin.position, next.position);

            const tramo = await lookupRoute(
                origin.position,
                next.position,
                departureHeading,
                document.cookie,
            );

            if (props.mode !== 'guide' || geometryRevision !== revision) {
                return;
            }

            if (
                tramo === null ||
                tramo.status !== 'ok' ||
                tramo.coordinates === null
            ) {
                failed.push(describeRouteRefusal(tramo?.reason ?? null));
            } else {
                const nextEnd = tramo.coordinates[tramo.coordinates.length - 1];
                // Re-derived on the CUT geometry, not on the one it was looked
                // up against: a projection may have written a vertex, and the
                // far bound read before that write points one vertex too far
                // along â€” which replaces somebody else's span and leaves this
                // one untouched, with nothing on screen saying so.
                const nextVertex = findVertexForWaypoint(
                    originBound.coordinates,
                    next,
                );

                if (
                    nextVertex === null ||
                    nextVertex.index <= originBound.address.index
                ) {
                    failed.push(
                        'the control ahead is off the route. Drag that one ' +
                            'onto it first, then move this one again.',
                    );
                } else {
                    workingCoordinates = replaceTramoSpan(
                        originBound.coordinates,
                        originBound.address,
                        nextVertex,
                        answerOf(tramo.coordinates),
                    );

                    workingWaypoints = workingWaypoints.map((waypoint, i) =>
                        i === index + 1
                            ? {
                                  position: nextEnd,
                                  role: waypoint.role,
                              }
                            : waypoint,
                    );
                }
            }
        }
    }

    emitGuided(
        workingCoordinates === coordinates ? null : workingCoordinates,
        workingWaypoints,
    );

    announceGuided(
        failed.length > 0
            ? `The control moved, but ${failed.join('; ')}.`
            : 'Tramos recalculated around the moved control.' +
                  describeSimplification(dropped, maxDeviation),
    );

    // The layer is reconciled from the state, last, always.
    //
    // The drag moved a Leaflet marker directly, so a refusal left it wherever
    // the reviewer let go of it with the recipe unchanged and nothing to
    // repaint it: a dot on the map that looked like a control being added and
    // was not one. The parent's props have settled by now, so whatever actually
    // happened is what gets drawn.
    await nextTick();
    renderGuidedMarkers();
}

// ---------------------------------------------------------------------------
// Spec Â§4.5: removing an interior control, offered and confirmed.
// ---------------------------------------------------------------------------

/** The removal offer: the joined tramo, dashed, awaiting the confirm. */
function startRemovePreview(): void {
    const index = selectedWaypoint.value;

    if (index === null || guidedOffer.value !== null) {
        return;
    }

    const waypoints = waypointsForGuide.value;
    const coordinates = props.geoJson?.coordinates ?? [];
    const join = removalJoin(coordinates, waypoints, index);

    if (join === null) {
        // Re-routing the joined tramo is the rich half of this removal, and it
        // needs both neighbours on the route to delimit a span. That is not a
        // reason to refuse the whole edit: a control whose neighbours have
        // drifted off is precisely the control a reviewer wants gone, so it goes
        // and says what it did NOT do.
        //
        // The label and this branch ask removalJoin() the same question, so the
        // button that said "Remove only" cannot arrive here promising a preview.
        const without = removeWaypoint(waypoints, index);

        if (without === null) {
            announceGuided(
                'This control cannot be removed: it is no longer part of the ' +
                    'recipe.',
            );

            return;
        }

        emitGuided(null, without);
        announceGuided(describeRemoveWithoutReroute());

        return;
    }

    const from = waypoints[index - 1] as Waypoint;
    const to = waypoints[index + 1] as Waypoint;

    void offerRemoval(index, from, to, join.from, join.to);
}

async function offerRemoval(
    index: number,
    from: Waypoint,
    to: Waypoint,
    fromVertex: VertexAddress,
    toVertex: VertexAddress,
): Promise<void> {
    const coordinates = props.geoJson?.coordinates ?? [];

    announceGuided(describeRoutedPending());

    const revision = ++geometryRevision;

    const found = await lookupRoute(
        from.position,
        to.position,
        headingAtVertex(coordinates, fromVertex.segment, fromVertex.index) ??
            headingBetween(from.position, to.position),
        document.cookie,
    );

    if (props.mode !== 'guide' || geometryRevision !== revision) {
        return;
    }

    if (found === null || found.status !== 'ok' || found.coordinates === null) {
        announceGuided(describeRouteRefusal(found?.reason ?? null));

        return;
    }

    const simplified = simplifyRoutedChain(found.coordinates);

    guidedOffer.value = {
        kind: 'remove',
        tramos: [simplified.positions],
        removeIndex: index,
        spanFrom: fromVertex,
        spanTo: toVertex,
        label:
            describeRoute(found.streets ?? [], found.distanceM) +
            describeSimplification(simplified.dropped, simplified.maxDeviation),
    };

    announceGuided(
        `${guidedOffer.value.label}. Accept to join the tramo without the control, or Reject.`,
    );
    renderGuidedPreview();
}

/**
 * How to select vertices in the mode on, behind a toggle rather than in prose.
 *
 * Instruction moved out of the way because it was never short enough to scan,
 * because it was the same three gestures repeated in three modes, and because a
 * reviewer who has used the editor twice already knows it. The audience a help
 * button actually serves is the one who has not.
 */
const modeHelp = computed(() => describeModeHelp(props.mode ?? 'move'));

/**
 * The selection, said when there is something to say about it.
 *
 * The one piece of the old hints that survives on screen, because it is state
 * and not instruction: it changes with what the reviewer just did, and it is
 * what tells them the next press will act on the set they can see highlighted.
 */
const selectionState = computed(() =>
    describeSelectionState(props.mode ?? 'move', selection.value.length),
);

const helpOpen = ref(false);

/**
 * Whether the selection is a stretch a re-spacing can actually walk.
 *
 * The rule itself is resampleBlock's, in lib/. What is left here is the part that
 * is genuinely about this component: whether the feature is on and whether the
 * mode is the one that offers it. Keeping the two apart is what stops the button
 * from needing its own copy of the two refusals.
 */
const resampleBlockReason = computed(() => resampleBlock(selection.value));

const canResample = computed(
    () =>
        props.resample === true &&
        (props.mode ?? 'move') === 'move' &&
        resampleBlockReason.value === null,
);

/**
 * Why the re-space button is unavailable, or what it will do.
 *
 * The refusals are spelled out rather than left to a disabled control. A
 * reviewer who cannot use a button has no way to tell whether it is waiting for
 * a selection, waiting for a contiguous one, or broken.
 */
const resampleHint = computed(() =>
    describeResampleHint(resampleBlockReason.value),
);

/**
 * The interval a re-space will use, with the default applied in one place.
 *
 * The picker next to the button and the press of the button have to agree, and
 * they read from this rather than each carrying their own fallback â€” two
 * defaults that drift apart produce a control showing 200 m and a re-space at
 * the prop it was not given.
 */
const DEFAULT_RESAMPLE_SPACING: ResampleSpacing = 200;

const resampleInterval = computed<ResampleSpacing>(
    () => props.resampleSpacing ?? DEFAULT_RESAMPLE_SPACING,
);

/**
 * Why the re-lay is unavailable, or what it will do.
 *
 * The re-lay has no segment rule of its own â€” a selection of two vertices on
 * different segments is still two vertices it can look up streets for â€” so the
 * only thing standing in the way is not having two yet.
 */
const relayHint = computed(() =>
    describeRelayHint(selection.value.length < 2 ? 'too-few' : null),
);

/**
 * Re-space the selected stretch to even intervals.
 *
 * Written like any other map edit and emitted as one, so the parent's history
 * records it as a single undo step. That matters more here than for the other
 * actions: this one can drop a hundred vertices and add two hundred, and undoing
 * that a few vertices at a time is not a recovery.
 *
 * The selection is cleared here rather than left to the watcher on `geoJson`,
 * which fires on the next tick. A selection addresses vertices by index, and a
 * re-spacing renumbers every vertex after the one it inserted, so a second press
 * landing in the gap would re-space a different stretch than the one the
 * reviewer picked. Clearing the ref is free and takes the reasoning out of it.
 */
function applyResample(): void {
    const coordinates = props.geoJson?.coordinates;
    const spacing = resampleInterval.value;

    if (!canResample.value || !coordinates) {
        return;
    }

    const result = resampleSelection(coordinates, selection.value, spacing);

    // Unchanged geometry still gets a sentence, because pressing the button and
    // seeing nothing happen is indistinguishable from a broken one. Nothing is
    // emitted, so the page does not become dirty for a no-op.
    if (result.coordinates === coordinates) {
        announceResample(describeResample(result, spacing));

        return;
    }

    // Bumped so a street lookup still in flight from an earlier drop is
    // discarded rather than applied to geometry it was not computed for. Same
    // guard the snap and the re-lay both use.
    geometryRevision += 1;
    clearSelection();
    announceResample(describeResample(result, spacing));
    skipNextFitBounds = true;
    emit('update:geoJson', {
        type: 'MultiLineString' as const,
        coordinates: result.coordinates,
    });
}

/** What a bulk deletion took, said in full because it can take a segment. */
const removalLabel = ref<string | null>(null);
let removalLabelTimer: ReturnType<typeof setTimeout> | null = null;

function announceRemoval(label: string | null): void {
    if (removalLabelTimer) {
        clearTimeout(removalLabelTimer);
    }

    removalLabel.value = label;

    if (label !== null) {
        removalLabelTimer = setTimeout(() => {
            removalLabel.value = null;
        }, 9000);
    }
}

/**
 * Delete every selected vertex in one step.
 *
 * The button is the only thing in this mode that touches a set. A plain click
 * still removes the one vertex it landed on, so the single-vertex gesture nobody
 * has to learn keeps working and a bulk deletion is always deliberate.
 *
 * Emitted as one change so the parent's history records it as one undo step. That
 * is the whole safety net here, and it is also the reason there is no
 * confirmation: a reviewer who deletes sixty vertices gets one Ctrl+Z, not sixty
 * of them, and a dialog asking them to confirm a change that is one keystroke
 * away from being undone is a worse trade.
 *
 * The selection is cleared here rather than left to the watcher on `geoJson`,
 * which fires on the next tick. That is not good enough for this action: a
 * selection addresses vertices by index, and every removal renumbers the ones
 * after it, so a second press landing in the gap would delete a different set of
 * vertices than the one the reviewer picked. Clearing the ref is free and removes
 * the reasoning entirely.
 */
function deleteSelection(): void {
    const coordinates = props.geoJson?.coordinates;

    if (!coordinates || selection.value.length === 0) {
        return;
    }

    const result = removeVertices(coordinates, selection.value);

    // A selection the route no longer has, or one that would empty it. Either
    // way nothing is emitted, so the page does not become dirty for a refusal.
    if (result.coordinates === coordinates) {
        announceRemoval(describeRemoval(result));

        return;
    }

    clearSelection();
    geometryRevision += 1;
    announceRemoval(describeRemoval(result));
    skipNextFitBounds = true;
    emit('update:geoJson', {
        type: 'MultiLineString' as const,
        coordinates: result.coordinates,
    });
}

function clearVertexMarkers(): void {
    vertexMarkers.forEach((m) => map?.removeLayer(m));
    vertexMarkers = [];
    vertexMarkersByRef = new Map();
    dragCoords = null;
}

function clearLayers(): void {
    if (polyline) {
        map?.removeLayer(polyline);
        polyline = null;
    }

    endpointMarkers.forEach((m) => map?.removeLayer(m));
    endpointMarkers = [];

    clearVertexMarkers();
    clearGuidedMarkers();
    clearGuidedLayer();
}

/**
 * Escape drops the selection, and the pending preview and anchors with it.
 *
 * Without it there is no way back to a single-vertex drag once a range is
 * picked, short of shift-clicking somewhere useless; a preview judged by
 * accident needs the same escape hatch. Anchors go too, because a batch of
 * them is a judgement in progress like any other and the reviewer abandoning
 * one should not have to hunt for the button to say so.
 *
 * Ctrl/Cmd+Z is claimed here for the same reason it is claimed by the page for
 * the line: while a batch is half placed, undo means taking the batch back.
 * Letting it through would undo the last edit the reviewer ACCEPTED â€” the worst
 * possible answer to "take that point back". `stopImmediatePropagation` because
 * the page's own handler is on the same node, and it stands down anyway on the
 * `defaultPrevented` it leaves behind: whichever of the two runs first wins, so
 * this does not depend on which registered its listener first.
 */
function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
        clearSelection();
        selectedWaypoint.value = null;

        if (guidedOffer.value !== null) {
            guidedOffer.value = null;
            clearGuidedLayer();
        }

        if (pendingAnchors.value.length > 0) {
            discardPendingAnchors();
            announceGuided('Anchors discarded. Ctrl+Z takes them back.');
        }

        return;
    }

    if (props.mode !== 'guide' || (!e.metaKey && !e.ctrlKey)) {
        return;
    }

    if (isTextEntryTarget(e.target)) {
        return;
    }

    const key = e.key.toLowerCase();

    if (key === 'z' && !e.shiftKey) {
        if (undoPendingAnchors()) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }

        return;
    }

    if ((key === 'z' && e.shiftKey) || key === 'y') {
        if (redoPendingAnchors()) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }
}

onMounted(() => {
    renderMap();
    window.addEventListener('resize', handleWindowResize);
    document.addEventListener('keydown', handleKeydown);
});

// A selection addresses vertices by index, so it only means something against
// the geometry it was picked from. New geometry means a new route to select on.
// A preview offered against geometry that has since changed is stale by the
// same token â€” dismissed, not applied.
watch(() => props.geoJson, renderMap, { deep: true });
watch(() => props.geoJson, clearSelection, { deep: true });
watch(() => props.geoJson, dismissPendingPreview, { deep: true });
watch(() => props.geoJson, reorderPendingAnchors, { deep: true });
watch(() => props.guidedWaypoints, renderGuidedMarkers, { deep: true });
watch(selectedWaypoint, () => {
    refreshWaypointSelection();
});
watch(
    () => props.mode,
    async (newMode) => {
        if (!props.editable) {
            return;
        }

        // Guided mode owns a state the other modes do not: entering it
        // starts a fresh proposal session (nothing pending, hand drawing
        // off), leaving it takes both down. The control list itself is the
        // parent's â€” it survives the mode switch and the undo stack with it.
        if (newMode === 'guide') {
            cancelPendingPreview();
            announceGuided('Click to place the first control point.');
        } else {
            cancelPendingPreview();
        }

        clearVertexMarkers();
        clearSelection();

        const coordinates = props.geoJson?.coordinates;

        if (coordinates?.length) {
            addVertexMarkers(coordinates, toLatLngs(coordinates), newMode!);
        }

        // Entering guided mode is not a geometry change, so renderMap never runs
        // for it and the controls would not be painted. A saved recipe opened
        // with this mode already active is exactly the case that used to show
        // an empty map where the reviewer expected their control points.
        renderGuidedMarkers();

        updateMapClickListener(newMode!);

        await nextTick();
        map?.invalidateSize();
    },
);
watch(
    () => props.editable,
    async (editable) => {
        clearVertexMarkers();
        clearSelection();

        if (editable) {
            const coordinates = props.geoJson?.coordinates;

            if (coordinates?.length) {
                addVertexMarkers(
                    coordinates,
                    toLatLngs(coordinates),
                    props.mode ?? 'move',
                );
            }
        }

        updateMapClickListener(props.mode ?? 'move');

        // The same rule the mode watcher follows: toggling the map between
        // editing and looking never reaches renderMap, so the controls have to
        // be repainted here or a read-only view keeps wearing them.
        renderGuidedMarkers();

        await nextTick();
        map?.invalidateSize();
    },
);

onUnmounted(() => {
    window.removeEventListener('resize', handleWindowResize);
    document.removeEventListener('keydown', handleKeydown);

    if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
    }

    if (snapLabelTimer) {
        clearTimeout(snapLabelTimer);
        snapLabelTimer = null;
    }

    if (relayLabelTimer) {
        clearTimeout(relayLabelTimer);
        relayLabelTimer = null;
    }

    if (resampleLabelTimer) {
        clearTimeout(resampleLabelTimer);
        resampleLabelTimer = null;
    }

    if (removalLabelTimer) {
        clearTimeout(removalLabelTimer);
        removalLabelTimer = null;
    }

    if (guidedLabelTimer) {
        clearTimeout(guidedLabelTimer);
        guidedLabelTimer = null;
    }

    clearLayers();

    if (map) {
        map.off('click', handleAddVertexClick);
        map.off('mousedown', startMarquee);
        map.remove();
        map = null;
    }

    marqueeLayer = null;
    isDragging = false;
});
</script>

<template>
    <div>
        <!--
            The toolbar, above the map.

            Everything the reviewer sets and everything they press lives here, and
            only what happened lives below. It used to be the other way round: the
            modes and the settings sat above, the three action buttons sat below,
            and every instruction was on the far side of the map from the control
            it explained â€” so reaching Re-lay meant scrolling past four hundred
            pixels of tile to get to it, and the sentence about Shift-click was a
            screen away from the mode picker that decides it.

            The split is deliberate rather than tidiness. A control and the words
            describing it belong in the same field of view as the thing they act
            on; a result belongs next to that thing because it is a report about
            it. Nothing below the map here is a control.
        -->
        <div v-if="editable || $slots.toolbar" class="space-y-3">
            <!--
                The help toggle, last in the row and quiet on purpose. It is the
                least interesting control on screen until someone needs it, and a
                help button that draws attention to itself defeats the reason the
                instructions moved behind it.

                A real CollapsibleTrigger rather than a click handler with a
                hand-written aria-expanded: the trigger already owns the expanded
                state, the aria-controls link and the keyboard handling, and a
                second copy of any of those is one that quietly stops matching.
            -->
            <Collapsible v-if="editable" v-model:open="helpOpen">
                <div class="flex flex-wrap items-center gap-3">
                    <slot name="toolbar" />

                    <TooltipProvider :delay-duration="0">
                        <Tooltip>
                            <TooltipTrigger as-child>
                                <CollapsibleTrigger as-child>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                    >
                                        <HelpCircle class="size-4" />
                                        <span class="sr-only">
                                            How to select vertices in this mode
                                        </span>
                                    </Button>
                                </CollapsibleTrigger>
                            </TooltipTrigger>
                            <TooltipContent class="max-w-xs">
                                <p>{{ modeHelp }}</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                </div>

                <CollapsibleContent
                    class="mt-3 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
                >
                    {{ modeHelp }}
                </CollapsibleContent>
            </Collapsible>

            <div v-else class="flex flex-wrap items-center gap-3">
                <slot name="toolbar" />
            </div>

            <!--
                    This row does not wrap, and that is the whole reason the map
                    stops lurching. The map below has a FIXED height, so anything
                    that changes the height of the block above it moves the map:
                    a control appearing or disappearing while the reviewer is
                    mid-gesture takes the map out from under the click that is
                    being judged. A row that can wrap turns every width change
                    into a height change.

                    `flex-nowrap` plus `min-w-0` and `overflow-x-auto` on the
                    part that can grow means a narrow window scrolls the controls
                    instead of stacking them, and the scrollbar is hidden in the
                    styles below because a visible one is fifteen pixels tall and
                    would reintroduce exactly the shift this is fixing.
                -->
            <div
                v-if="editable"
                class="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-x-auto"
            >
                <!--
                    A spacer, and permanently rendered rather than standing in
                    for a readout that is not there.

                    It is zero-height and carries no text, so it cannot make
                    this row change size â€” it exists only to hold the action
                    buttons against the right edge, which is what the readout's
                    `flex-1` used to do before the count moved over the map.
                -->
                <div class="flex-1" />

                <div class="flex flex-wrap items-center gap-2">
                    <template v-if="mode === 'move'">
                        <!--
                            The trigger is a span around the button rather than
                            the button, which is the whole reason these tooltips
                            can do their job. A disabled button fires no pointer
                            events, so a title or a trigger placed on it stays
                            silent â€” and the disabled state is exactly when the
                            explanation is wanted, because it is the reason the
                            button cannot be pressed.
                        -->
                        <TooltipProvider :delay-duration="0">
                            <Tooltip>
                                <TooltipTrigger as-child>
                                    <span class="inline-flex">
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            :disabled="selection.length < 2"
                                            @click="relaySelection"
                                        >
                                            <Waves class="size-4" />
                                            Re-lay
                                        </Button>
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent class="max-w-xs">
                                    <p>{{ relayHint }}</p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>

                        <!--
                            The interval sits next to the button it governs rather
                            than up in the settings group. "Re-space at 200 m" is
                            one decision, and splitting it across two groups meant
                            looking up to check the number and back down to press
                            the thing that used it.
                        -->
                        <div v-if="resample" class="flex items-center gap-2">
                            <TooltipProvider :delay-duration="0">
                                <Tooltip>
                                    <TooltipTrigger as-child>
                                        <span class="inline-flex">
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                :disabled="!canResample"
                                                @click="applyResample"
                                            >
                                                <Ruler class="size-4" />
                                                Re-space
                                            </Button>
                                        </span>
                                    </TooltipTrigger>
                                    <TooltipContent class="max-w-xs">
                                        <p>{{ resampleHint }}</p>
                                    </TooltipContent>
                                </Tooltip>
                            </TooltipProvider>
                            <select
                                :value="resampleInterval"
                                aria-label="Re-space interval"
                                class="h-9 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-xs"
                                @change="
                                    emit(
                                        'update:resampleSpacing',
                                        Number(
                                            ($event.target as HTMLSelectElement)
                                                .value,
                                        ) as ResampleSpacing,
                                    )
                                "
                            >
                                <option
                                    v-for="spacing in RESAMPLE_SPACING_METERS"
                                    :key="spacing"
                                    :value="spacing"
                                >
                                    {{ spacing }} m
                                </option>
                            </select>
                        </div>
                    </template>

                    <!--
                        Guided mode's own row, in the order the work happens:
                        how the next click behaves on the left, what that gesture
                        offers beside it, and the pending judgement pushed to the
                        far end where it cannot be pressed by accident while the
                        reviewer is still placing points.

                        The gesture is ONE three-way switch rather than the toggles
                        it replaced: two of them could be live at once, and the row
                        would name one while the click handler did the other.
                    -->
                    <template v-if="mode === 'guide'">
                        <Separator
                            orientation="vertical"
                            class="mx-1 hidden h-6 sm:block"
                        />

                        <div
                            class="inline-flex items-center gap-1"
                            role="group"
                            aria-label="What a click on the map does"
                        >
                            <Button
                                v-for="option in GUIDE_GESTURES"
                                :key="option.id"
                                type="button"
                                :variant="
                                    guideGesture === option.id
                                        ? 'default'
                                        : 'outline'
                                "
                                size="sm"
                                :aria-pressed="guideGesture === option.id"
                                @click="setGuideGesture(option.id)"
                            >
                                <component :is="option.icon" class="size-4" />
                                {{ option.label }}
                            </Button>
                        </div>

                        <!--
                            Only what the live gesture can act on. The frontier is
                            meaningless to anchors, and a control that does nothing
                            under the gesture that is selected is a control the
                            reviewer has to read past.
                        -->
                        <div class="inline-flex items-center gap-2">
                            <span
                                v-if="
                                    guideGesture === 'trace' &&
                                    waypointsForGuide.length > 0
                                "
                                class="inline-flex items-center gap-1"
                            >
                                <span class="text-xs text-muted-foreground">
                                    Extend at
                                </span>
                                <Button
                                    type="button"
                                    :variant="
                                        guideFrontier === 'head'
                                            ? 'default'
                                            : 'outline'
                                    "
                                    size="sm"
                                    :aria-pressed="guideFrontier === 'head'"
                                    @click="setGuideFrontier('head')"
                                >
                                    Start
                                </Button>
                                <Button
                                    type="button"
                                    :variant="
                                        guideFrontier === 'head'
                                            ? 'outline'
                                            : 'default'
                                    "
                                    size="sm"
                                    :aria-pressed="guideFrontier === 'tail'"
                                    @click="setGuideFrontier('tail')"
                                >
                                    End
                                </Button>
                            </span>

                            <!--
                                A pending batch keeps its own action reachable
                                whatever gesture is selected after it: hiding
                                "Preview rebuild" while three anchors sit there
                                is how a half-placed batch becomes unreachable.
                                Escape discards it, which is why there is no
                                second button saying so.
                            -->
                            <template
                                v-if="
                                    guideGesture === 'anchors' ||
                                    pendingAnchors.length > 0
                                "
                            >
                                <TooltipProvider :delay-duration="0">
                                    <Tooltip>
                                        <TooltipTrigger as-child>
                                            <!--
                                                The trigger wraps the button rather
                                                than being the button: a disabled
                                                one fires no pointer events, so the
                                                explanation â€” which is wanted most
                                                exactly when it is disabled â€” would
                                                never show.
                                            -->
                                            <span class="inline-flex">
                                                <Button
                                                    type="button"
                                                    variant="default"
                                                    size="sm"
                                                    :disabled="
                                                        pendingAnchors.length <
                                                        2
                                                    "
                                                    @click="previewRectify"
                                                >
                                                    <Route class="size-4" />
                                                    Preview rebuild
                                                </Button>
                                            </span>
                                        </TooltipTrigger>
                                        <TooltipContent class="max-w-xs">
                                            <p>
                                                {{
                                                    describeAnchorsNeeded(
                                                        pendingAnchors.length,
                                                    )
                                                }}
                                            </p>
                                        </TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                            </template>
                        </div>

                        <div class="flex-1" />

                        <!--
                            The removal, always on screen and never hidden â€” a
                            button that is not there is a button nobody learns
                            exists, and the tooltip that explains a disabled state
                            is only useful to someone who can already see it.
                            Which is why it also carries the refusal: the start
                            and end of a route cannot be removed, and saying so
                            here beats a reviewer pressing a button that used to
                            do nothing at all.

                            It sits to the LEFT of Reject and Accept rather than
                            beside Accept: one is how a control goes away, the
                            other is how a proposal is committed, and a
                            destructive button within a thumb's reach of the one
                            that commits geometry is how a proposal gets accepted
                            by accident.
                        -->
                        <TooltipProvider :delay-duration="0">
                            <Tooltip>
                                <TooltipTrigger as-child>
                                    <span class="inline-flex">
                                        <Button
                                            type="button"
                                            variant="destructive"
                                            size="sm"
                                            :disabled="
                                                removeControlBlock !== ''
                                            "
                                            @click="startRemovePreview"
                                        >
                                            <Trash2 class="size-4" />
                                            {{
                                                removeReroutes
                                                    ? 'Remove control'
                                                    : 'Remove only'
                                            }}
                                        </Button>
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent class="max-w-xs">
                                    <p>
                                        {{
                                            removeControlBlock ||
                                            (removeReroutes
                                                ? 'Removes the selected control and re-routes the tramo it joined, shown dashed for you to accept.'
                                                : describeRemoveWithoutReroute())
                                        }}
                                    </p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>

                        <template v-if="guidedOffer">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                @click="rejectPreview"
                            >
                                <X class="size-4" />
                                Reject
                            </Button>
                            <Button
                                type="button"
                                variant="default"
                                size="sm"
                                @click="acceptPreview"
                            >
                                <Check class="size-4" />
                                {{
                                    guidedOffer.kind === 'rectify'
                                        ? 'Accept rebuild'
                                        : 'Accept tramo'
                                }}
                            </Button>
                        </template>
                    </template>

                    <!--
                        Pushed to the far end of the row, and the reason is the
                        one thing colour alone cannot carry. Destructive stands
                        apart from safe by shade; what keeps a re-space from
                        becoming a mass delete is the distance between the two
                        buttons when both are live. Never hidden â€” a button that
                        is not on screen is a button nobody learns exists, and the
                        tooltip that explains a disabled state is only useful to
                        someone who can already see it.
                    -->
                    <template v-if="mode === 'delete'">
                        <TooltipProvider :delay-duration="0">
                            <Tooltip>
                                <TooltipTrigger as-child>
                                    <span class="ms-auto inline-flex">
                                        <Button
                                            type="button"
                                            variant="destructive"
                                            size="sm"
                                            :disabled="selection.length === 0"
                                            @click="deleteSelection"
                                        >
                                            <Trash2 class="size-4" />
                                            <template
                                                v-if="selection.length > 0"
                                            >
                                                Delete {{ selection.length }}
                                                {{
                                                    selection.length === 1
                                                        ? 'vertex'
                                                        : 'vertices'
                                                }}
                                            </template>
                                            <template v-else>Delete</template>
                                        </Button>
                                    </span>
                                </TooltipTrigger>
                                <!--
                                    Static, so it lives in the template rather
                                    than in a function in lib/. There is nothing
                                    here to compute and nothing to assert; a
                                    no-argument function would only make the
                                    wording harder to find.
                                -->
                                <TooltipContent class="max-w-xs">
                                    <p>
                                        One undo step takes all of them back. A
                                        stretch left with fewer than two points
                                        is dropped rather than kept as a stub.
                                    </p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    </template>
                </div>
            </div>
        </div>

        <!--
            Relative, and only so the status overlay below has something to
            position against. The wrapper itself is otherwise unchanged.
        -->
        <div
            class="relative"
            :class="{
                'cursor-crosshair':
                    editable && (mode === 'add' || mode === 'guide'),
                'cursor-pointer': editable && mode === 'delete',
            }"
        >
            <div
                ref="mapContainer"
                class="h-[clamp(400px,60vh,700px)] w-full rounded-md border"
            />

            <!--
                Everything the map reports back, in one overlay and one corner.

                A selection count and four action messages, and they used to live
                in two places: the count sat in the toolbar, the messages sat
                below the map. Both were wrong, for the same underlying reason.
                The map is up to seven hundred pixels tall, so a paragraph under
                it is a long way from the click that caused it â€” and the
                messages were worse than far, because they also pushed the
                endpoint legend under the map down and pulled it back on every
                snap, the same lurch this overlay exists to end.

                One column in the top right, because these co-occur: you select,
                you drag, it snaps, and the count is what tells you the next
                press will act on the set you can see highlighted. Top right
                rather than top left is Leaflet's doing â€” the zoom control is
                enabled and sits there by default. This map has the attribution
                control off and no layer control, which leaves this corner free.

                `pointer-events-none` is on the wrapper rather than repeated per
                child, and it is load-bearing: a click landing on a message
                instead of on a vertex would be the toolbar's bug all over
                again, one layer down.

                `role="status"` on the wrapper rather than `aria-live` on each
                child, for the same reason it is one region and not four. These
                appear in response to something done elsewhere on the screen, so
                without a live region a screen reader announces nothing at all â€”
                and four independent regions announce over each other when two
                messages land together.

                `z-[1001]` is a magic number tied to Leaflet's stacking scale, so
                the arithmetic is worth writing down. Its panes run 200 (tiles)
                through 700 (popups), the controls are 800 and the control
                corners 1000. None of it is contained: `.leaflet-container`
                declares no z-index and so creates no stacking context, and
                neither does the wrapper above, which is `relative` with
                `z-index: auto`. Everything is in one shared context, which is
                why the reflexive `z-10` leaves this overlay rendering perfectly
                and invisible underneath the map. 1001 rather than 1000 so it
                cannot tie with `.leaflet-top` and fall back to DOM order.

                The width cap is doing two jobs. `85%` keeps a long message
                inside a narrow map and lets it wrap; the `sm:` ceiling stops a
                re-lay report â€” which covers a hundred vertices across several
                streets â€” from running the full width of a wide screen.
            -->
            <div
                v-if="editable"
                role="status"
                class="pointer-events-none absolute top-2 right-2 z-[1001] flex max-w-[85%] flex-col items-end gap-2 sm:max-w-[22rem]"
            >
                <!--
                    Conditional rather than always rendered: `selectionState` is
                    an empty string for an empty selection and in add mode, and
                    an unconditional element here would leave an empty pill
                    sitting in the corner of the map with padding and a
                    background and nothing in it.
                -->
                <p
                    v-if="selectionState"
                    class="rounded-md bg-background/90 px-2 py-1 text-xs font-medium shadow-sm backdrop-blur-sm"
                >
                    {{ selectionState }}
                </p>

                <!--
                    The emerald is what these had when they were plain text on
                    the page background. Over map tiles, unbacked text is
                    unreadable, so they take the same pill as the count above.
                -->
                <p
                    v-if="snapLabel"
                    class="rounded-md bg-background/90 px-2 py-1 text-xs text-emerald-700 shadow-sm backdrop-blur-sm dark:text-emerald-400"
                >
                    Snapped onto {{ snapLabel }}.
                </p>
                <p
                    v-if="guidedLabel"
                    class="rounded-md bg-background/90 px-2 py-1 text-xs font-medium text-amber-700 shadow-sm backdrop-blur-sm dark:text-amber-400"
                >
                    {{ guidedLabel }}
                </p>
                <p
                    v-if="detachedText"
                    class="rounded-md bg-background/90 px-2 py-1 text-xs text-amber-700 shadow-sm backdrop-blur-sm dark:text-amber-400"
                >
                    {{ detachedText }}
                </p>
                <p
                    v-if="relayLabel"
                    class="rounded-md bg-background/90 px-2 py-1 text-xs text-emerald-700 shadow-sm backdrop-blur-sm dark:text-emerald-400"
                >
                    {{ relayLabel }}
                </p>
                <p
                    v-if="resampleLabel"
                    class="rounded-md bg-background/90 px-2 py-1 text-xs text-emerald-700 shadow-sm backdrop-blur-sm dark:text-emerald-400"
                >
                    {{ resampleLabel }}
                </p>
                <p
                    v-if="removalLabel"
                    class="rounded-md bg-background/90 px-2 py-1 text-xs text-emerald-700 shadow-sm backdrop-blur-sm dark:text-emerald-400"
                >
                    {{ removalLabel }}
                </p>
            </div>
        </div>
        <p
            v-if="!geoJson && !editable"
            class="mt-2 text-sm text-muted-foreground"
        >
            No geometry data available.
        </p>
        <p
            v-if="!geoJson && editable"
            class="mt-2 text-sm text-muted-foreground"
        >
            Click on the map to start drawing the route.
        </p>
        <div
            v-if="!editable && hasGeometry"
            class="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground"
        >
            <span class="flex items-center gap-1.5">
                <i data-endpoint="start"></i>
                Start
            </span>
            <span class="flex items-center gap-1.5">
                <i data-endpoint="end"></i>
                End
            </span>
        </div>
    </div>
</template>

<style scoped>
/*
   The toolbar row scrolls rather than wraps, and its scrollbar is hidden.

   Not cosmetic: a visible horizontal scrollbar is about fifteen pixels tall and
   this row sits directly above a map of fixed height, so letting it appear is
   the same lurch the nowrap was there to end â€” it just happens on the window's
   first resize instead of on every click. The row can still be scrolled by
   trackpad or keyboard, which is what a mouse-only reviewer would not have.
*/
.no-scrollbar {
    scrollbar-width: none;
    -ms-overflow-style: none;
}

.no-scrollbar::-webkit-scrollbar {
    display: none;
}

.cursor-crosshair :deep(.leaflet-container),
.cursor-crosshair :deep(.leaflet-interactive) {
    cursor: crosshair !important;
}

.cursor-pointer :deep(.leaflet-container),
.cursor-pointer :deep(.leaflet-interactive) {
    cursor: pointer !important;
}

/* Leaflet builds these divIcons in its own panes, so the selectors have to
   reach out of the scoped tree with :deep(). */
:deep(i[data-endpoint]) {
    display: block;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    border-radius: 9999px;
    border: 2px solid #ffffff;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
}

:deep(.route-anchor) {
    background: transparent;
    border: none;
    /* Draggable and clickable, so it says so: a gesture with no pointer cue is
       a gesture the reviewer has to discover by moving the wrong thing. */
    cursor: grab;
}

:deep(.route-anchor:active) {
    cursor: grabbing;
}

:deep(i[data-anchor]) {
    display: block;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    border-radius: 9999px;
    border: 2px dashed #7c3aed;
    background-color: #7c3aed33;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
}

/*
   The anchors the last preview could not route between.

   Red is what "cannot" already means in this editor — the delete mode's
   vertices and a route's end pin — so it is not a new colour for a new idea.
   The dash becoming a solid is the second signal, because a hue on its own is
   the one thing a reviewer with a colour-blind screen cannot act on.
*/
:deep(i[data-anchor][data-failed]) {
    border-color: #dc2626;
    border-style: solid;
    background-color: #dc262633;
}

:deep(.route-anchor b) {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    color: #ffffff;
    text-shadow: 0 1px 2px rgb(0 0 0 / 0.8);
}

:deep(i[data-endpoint='start']) {
    background-color: #16a34a;
}

:deep(i[data-endpoint='end']) {
    background-color: #dc2626;
}
</style>
