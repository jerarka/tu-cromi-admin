<script setup lang="ts">
import L from 'leaflet';
import { nextTick, ref, watch, onMounted, onUnmounted } from 'vue';
import 'leaflet/dist/leaflet.css';

const props = defineProps<{
    geoJson: {
        type: 'MultiLineString';
        coordinates: number[][][];
    } | null;
    editable?: boolean;
    mode?: 'move' | 'add' | 'delete';
}>();

const emit = defineEmits<{
    (e: 'update:geoJson', value: NonNullable<typeof props.geoJson>): void;
}>();

const mapContainer = ref<HTMLElement | null>(null);
let map: L.Map | null = null;
let polyline: L.Polyline | null = null;
let vertexMarkers: L.CircleMarker[] = [];
let dragCoords: number[][][] | null = null;
let skipNextFitBounds = false;

function pointToSegmentDist(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) {
        return Math.hypot(px - ax, py - ay);
    }

    const t = Math.max(
        0,
        Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq),
    );

    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function findClosestSegment(
    latlng: L.LatLng,
    coords: number[][][],
): { segIdx: number; pointIdx: number } | null {
    let minDist = Infinity;
    let result: { segIdx: number; pointIdx: number } | null = null;

    coords.forEach((segment, segIdx) => {
        for (let i = 0; i < segment.length - 1; i++) {
            const dist = pointToSegmentDist(
                latlng.lat,
                latlng.lng,
                segment[i][1],
                segment[i][0],
                segment[i + 1][1],
                segment[i + 1][0],
            );

            if (dist < minDist) {
                minDist = dist;
                result = { segIdx, pointIdx: i };
            }
        }
    });

    return result;
}

function updateMapClickListener(mode: 'move' | 'add' | 'delete'): void {
    if (!map) {
        return;
    }

    map.off('click', handleAddVertexClick);

    if (props.editable && mode === 'add') {
        map.on('click', handleAddVertexClick);
    }
}

function handleAddVertexClick(e: L.LeafletMouseEvent): void {
    if (props.mode !== 'add' || !map) {
        return;
    }

    const coordinates = props.geoJson?.coordinates;

    if (!coordinates?.length) {
        const pos: [number, number] = [e.latlng.lng, e.latlng.lat];
        skipNextFitBounds = true;
        emit('update:geoJson', {
            type: 'MultiLineString' as const,
            coordinates: [[pos]],
        });

        return;
    }

    if (coordinates.length === 1 && coordinates[0].length <= 1) {
        const pos: [number, number] = [e.latlng.lng, e.latlng.lat];
        const newCoords = structuredClone(coordinates);
        newCoords[0].push(pos);
        skipNextFitBounds = true;
        emit('update:geoJson', {
            type: 'MultiLineString' as const,
            coordinates: newCoords,
        });

        return;
    }

    const result = findClosestSegment(e.latlng, coordinates);

    if (!result) {
        return;
    }

    const { segIdx, pointIdx } = result;
    const a = coordinates[segIdx][pointIdx];
    const b = coordinates[segIdx][pointIdx + 1];
    const pos: [number, number] = [e.latlng.lng, e.latlng.lat];

    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    let t = 0;

    if (lenSq > 0) {
        t = ((pos[0] - a[0]) * dx + (pos[1] - a[1]) * dy) / lenSq;
    }

    // Check if the click is close enough to the segment (within 300 meters)
    let closestProj: [number, number];

    if (t <= 0) {
        closestProj = [a[1], a[0]];
    } else if (t >= 1) {
        closestProj = [b[1], b[0]];
    } else {
        closestProj = [a[1] + t * dy, a[0] + t * dx];
    }

    const closestLatLng = L.latLng(closestProj[0], closestProj[1]);
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

    const newCoords = structuredClone(coordinates);

    if (t <= 0) {
        newCoords[segIdx].splice(pointIdx, 0, pos);
    } else if (t >= 1) {
        newCoords[segIdx].splice(pointIdx + 2, 0, pos);
    } else {
        newCoords[segIdx].splice(pointIdx + 1, 0, pos);
    }

    skipNextFitBounds = true;
    emit('update:geoJson', {
        type: 'MultiLineString' as const,
        coordinates: newCoords,
    });
}

function toLatLngs(coords: number[][][]): L.LatLngTuple[][] {
    return coords.map((segment) =>
        segment.map((coord) => [coord[1], coord[0]] as L.LatLngTuple),
    );
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
    }

    if (skipNextFitBounds) {
        skipNextFitBounds = false;
    } else {
        map.fitBounds(polyline.getBounds().pad(0.1));
    }
}

function addVertexMarkers(
    coords: number[][][],
    latlngs: L.LatLngTuple[][],
    mode: 'move' | 'add' | 'delete',
): void {
    coords.forEach((segment, segIdx) => {
        segment.forEach((_, pointIdx) => {
            const marker = L.circleMarker(latlngs[segIdx][pointIdx], {
                radius: 6,
                color: mode === 'delete' ? '#dc2626' : '#2563eb',
                fillColor: '#ffffff',
                fillOpacity: 1,
                weight: 2,
            });

            if (mode === 'move') {
                let wasDragged = false;

                marker.on('mousedown', (e: L.LeafletMouseEvent) => {
                    L.DomEvent.stopPropagation(e.originalEvent);

                    if (!dragCoords) {
                        dragCoords = structuredClone(coords);
                    }

                    wasDragged = false;
                    map?.dragging.disable();

                    const onMouseMove = (e: L.LeafletMouseEvent) => {
                        if (!dragCoords) {
                            return;
                        }

                        wasDragged = true;
                        const pos = e.latlng;

                        marker.setLatLng(pos);
                        dragCoords[segIdx][pointIdx] = [pos.lng, pos.lat];
                        updatePolylinePath();
                    };

                    const onMouseUp = (): void => {
                        map?.off('mousemove', onMouseMove);
                        map?.dragging.enable();
                        document.removeEventListener('mouseup', onMouseUp);

                        if (wasDragged && dragCoords) {
                            skipNextFitBounds = true;
                            const payload = {
                                type: 'MultiLineString' as const,
                                coordinates: dragCoords,
                            };
                            dragCoords = null;
                            emit('update:geoJson', payload);
                        } else {
                            dragCoords = null;
                        }
                    };

                    map?.on('mousemove', onMouseMove);
                    document.addEventListener('mouseup', onMouseUp);
                });
            } else if (mode === 'delete') {
                marker.on('click', (e: L.LeafletMouseEvent) => {
                    L.DomEvent.stopPropagation(e.originalEvent);

                    const newCoords = structuredClone(coords);
                    const segment = newCoords[segIdx];

                    if (segment.length <= 2) {
                        newCoords.splice(segIdx, 1);
                    } else {
                        segment.splice(pointIdx, 1);
                    }

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
        });
    });
}

function updatePolylinePath(): void {
    if (!polyline || !dragCoords) {
        return;
    }

    polyline.setLatLngs(toLatLngs(dragCoords));
}

function clearVertexMarkers(): void {
    vertexMarkers.forEach((m) => map?.removeLayer(m));
    vertexMarkers = [];
    dragCoords = null;
}

function clearLayers(): void {
    if (polyline) {
        map?.removeLayer(polyline);
        polyline = null;
    }

    clearVertexMarkers();
}

onMounted(renderMap);
watch(() => props.geoJson, renderMap, { deep: true });
watch(
    () => props.mode,
    async (newMode) => {
        if (!props.editable || !polyline) {
            return;
        }

        clearVertexMarkers();

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
    clearLayers();

    if (map) {
        map.off('click', handleAddVertexClick);
        map.remove();
        map = null;
    }
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
                class="h-[400px] w-full rounded-md border"
            />
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
</style>
