<script setup lang="ts">
import { Waves } from '@lucide/vue';
import L from 'leaflet';
import { computed, nextTick, ref, watch, onMounted, onUnmounted } from 'vue';
import 'leaflet/dist/leaflet.css';
import { Button } from '@/components/ui/button';
import { usePropagation } from '@/composables/usePropagation';
import { consumePreserveToken } from '@/lib/mapView';
import {
    applyDeltaToSelection,
    clampRange,
    decideSnap,
    findClosestSegment,
    insertVertexAt,
    projectOnSegment,
    propagationLimitsFor,
    propagateAlongStreet,
    rangeBetween,
    relayLimitsFor,
    relaySelectionOntoNetwork,
    removeVertexAt,
    routeEndpoints,
    snapOptionsFor,
    snapSample,
    verticesWithinBounds,
} from '@/lib/routeEditing';
import type {
    Coordinates,
    Position,
    SnapPreset,
    VertexRef,
} from '@/lib/routeEditing';
import {
    describeRelay,
    describeSnap,
    lookupRelayStreets,
    lookupSnapStreets,
} from '@/lib/snapTransport';

const props = defineProps<{
    geoJson: {
        type: 'MultiLineString';
        coordinates: number[][][];
    } | null;
    editable?: boolean;
    mode?: 'move' | 'add' | 'delete';
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
    (
        e: 'update:geoJson',
        value: NonNullable<typeof props.geoJson>,
        meta?: { snap?: boolean; propagated?: number },
    ): void;
}>();

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
 */
function startMarquee(e: L.LeafletMouseEvent): void {
    if (!map || !props.editable || (props.mode ?? 'move') !== 'move') {
        return;
    }

    // Plain drag on the background pans. Without this guard the marquee
    // swallowed every drag and the map became impossible to move while
    // editing — the marquee is the rarer action, so it takes the modifier.
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
 * by — each one lands at its own place along the street — so the positions are
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

function updateMapClickListener(mode: 'move' | 'add' | 'delete'): void {
    if (!map) {
        return;
    }

    map.off('click', handleAddVertexClick);
    map.off('mousedown', startMarquee);

    if (props.editable && mode === 'add') {
        map.on('click', handleAddVertexClick);
    }

    if (props.editable && mode === 'move') {
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
    mode: 'move' | 'add' | 'delete',
): L.CircleMarkerOptions {
    if (mode === 'delete') {
        return {
            radius: 6,
            color: '#dc2626',
            fillColor: '#ffffff',
            fillOpacity: 1,
            weight: 2,
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

function addVertexMarkers(
    coords: Coordinates,
    latlngs: L.LatLngTuple[][],
    mode: 'move' | 'add' | 'delete',
): void {
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
                    }

                    refreshMarkerStyles();
                });
            } else if (mode === 'delete') {
                marker.on('click', (e: L.LeafletMouseEvent) => {
                    L.DomEvent.stopPropagation(e.originalEvent);

                    const newCoords = removeVertexAt(coords, segIdx, pointIdx);

                    if (newCoords.length === 0) {
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
 * It stays in this file. It reads a dozen pieces of the map's state — the drag
 * coordinates, the selection, the marker styling, the polyline — and lifting it
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
        if (!isSelected(ref)) {
            clearSelection();
            selection.value = [ref];
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
    // unsnapped still has to take the last drop's message down with it — and
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
 * else. That is the whole reason the commit happens first — a drop the reviewer
 * made deliberately is never traded away for a network result.
 *
 * The whole selection is sampled, but the result is applied as a rigid offset.
 * The reference vertex decides where the route should sit; the rest of the
 * selection follows it without reshaping, because a stretch of route being
 * dragged across a block is one edit, not N. Sampling all of it is what makes
 * that offset trustworthy — it is how the street is chosen, and the choice is
 * made before the offset is computed.
 *
 * The offset only reaches the vertices that were dragged, and that is the gap
 * this second half exists to close: a one-vertex drag onto a street two blocks
 * over leaves its neighbours on the street it came from, so the route crosses
 * the block diagonally and the kink is the reviewer's first sign that the tool
 * did half a job. So once the street is settled, the vertices on either side of
 * the drop are walked onto it — forwards and backwards, because a route has a
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

    const found = await lookupSnapStreets(
        snapSample(coordinates, active, reference),
        options,
        document.cookie,
    );

    // A newer edit landed while this was in flight. Applying the offset now
    // would drag geometry the reviewer has since moved again, by an amount
    // derived from where it used to be — so the refinement is dropped and the
    // route stays exactly where they last put it.
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

    // The snap is applied first and the walk starts from the result, so the
    // reference is already on the centreline when the cursor is placed. Doing it
    // the other way round would start the walk from a point that is off the
    // street and put every propagated vertex that same distance off it, which is
    // the rigid offset this is here to replace.
    const snapped = applyDeltaToSelection(coordinates, active, offset);
    const propagation = spreadAlongStreet(snapped, reference, found.line);

    // The markers follow the snap rather than the raw drop, so the vertex the
    // reviewer sees is the one that was written. The propagated vertices are set
    // absolutely rather than by an offset, because a walk places each one on the
    // centreline at its own distance rather than moving them all by one amount.
    //
    // The order matters and is not interchangeable. A walked vertex can also be
    // in the dragged selection — grab the middle of a stretch and the walk
    // reaches the ones either side of it — so the two sets overlap. The absolute
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
 * clear the selection — the same thing it already does after a plain snap, but
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
 * map edit and the parent's history records it as one step — which is the whole
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
}

/**
 * Escape drops the selection.
 *
 * Without it there is no way back to a single-vertex drag once a range is
 * picked, short of shift-clicking somewhere useless.
 */
function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
        clearSelection();
    }
}

onMounted(() => {
    renderMap();
    window.addEventListener('resize', handleWindowResize);
    document.addEventListener('keydown', handleKeydown);
});

// A selection addresses vertices by index, so it only means something against
// the geometry it was picked from. New geometry means a new route to select on.
watch(() => props.geoJson, renderMap, { deep: true });
watch(() => props.geoJson, clearSelection, { deep: true });
watch(
    () => props.mode,
    async (newMode) => {
        if (!props.editable || !polyline) {
            return;
        }

        clearVertexMarkers();
        clearSelection();

        const coordinates = props.geoJson?.coordinates;

        if (coordinates?.length) {
            addVertexMarkers(coordinates, toLatLngs(coordinates), newMode!);
        }

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
        <div
            :class="{
                'cursor-crosshair': editable && mode === 'add',
                'cursor-pointer': editable && mode === 'delete',
            }"
        >
            <div
                ref="mapContainer"
                class="h-[clamp(400px,60vh,700px)] w-full rounded-md border"
            />
        </div>
        <p
            v-if="snapLabel"
            class="mt-2 text-sm text-emerald-700 dark:text-emerald-400"
        >
            Snapped onto {{ snapLabel }}.
        </p>
        <p
            v-if="relayLabel"
            class="mt-2 text-sm text-emerald-700 dark:text-emerald-400"
        >
            {{ relayLabel }}
        </p>
        <p
            v-if="editable && mode === 'move'"
            class="mt-2 text-sm text-muted-foreground"
        >
            <template v-if="selection.length > 1">
                {{ selection.length }} vertices selected. Drag any of them to
                move the whole stretch. Hold Alt to skip snapping, Escape to
                deselect.
            </template>
            <template v-else>
                Shift-click two vertices to grab everything between them, or
                Shift-drag on the map to box one out. Then drag any selected
                vertex to move them together. A dropped vertex snaps onto the
                nearest street — hold Alt to place it off the centreline.
            </template>
        </p>
        <div
            v-if="relay && editable && mode === 'move'"
            class="mt-3 flex items-center gap-3"
        >
            <Button
                type="button"
                variant="outline"
                size="sm"
                :disabled="selection.length < 2"
                :title="
                    selection.length < 2
                        ? 'Select at least two vertices to re-lay.'
                        : 'Move each selected vertex onto the street it belongs to, which is how a straight run drawn over a curving road gets its shape back.'
                "
                @click="relaySelection"
            >
                <Waves class="size-4" />
                Re-lay on the street network
            </Button>
            <p class="text-xs text-muted-foreground">
                Works on the shape, not just the position: each selected vertex
                moves onto its own street, so a stretch that turns a corner
                comes out right. Points with no street in range stay put.
            </p>
        </div>
        <!--
            Its own paragraph rather than a clause in the one above, because it
            only applies with the feature on and the reviewer who just turned it
            on needs to know what the button did to their route.
        -->
        <p
            v-if="editable && mode === 'move' && propagationEnabled"
            class="mt-2 text-sm text-muted-foreground"
        >
            A drop also pulls the vertices either side of it onto the same
            street, and stops at the first one too far off it to tell. Hold Alt
            to skip that along with the snap.
        </p>
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

:deep(i[data-endpoint='start']) {
    background-color: #16a34a;
}

:deep(i[data-endpoint='end']) {
    background-color: #dc2626;
}
</style>
