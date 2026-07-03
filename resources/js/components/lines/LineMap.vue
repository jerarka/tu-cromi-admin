<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const props = defineProps<{
    geoJson: {
        type: 'MultiLineString';
        coordinates: number[][][];
    } | null;
}>();

const emit = defineEmits<{
    (e: 'update:geoJson', value: typeof props.geoJson): void;
}>();

const mapContainer = ref<HTMLElement | null>(null);
let map: L.Map | null = null;
let polyline: L.Polyline | null = null;

function renderMap(): void {
    if (!mapContainer.value) return;

    if (!map) {
        map = L.map(mapContainer.value, {
            zoomControl: true,
            attributionControl: false,
        }).setView([-17.78, -63.18], 12);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
        }).addTo(map);
    }

    if (polyline) {
        map.removeLayer(polyline);
        polyline = null;
    }

    if (!props.geoJson?.coordinates?.length) return;

    const latlngs = props.geoJson.coordinates.map(
        (segment) => segment.map((coord) => [coord[1], coord[0]] as L.LatLngTuple),
    );

    polyline = L.polyline(latlngs, {
        color: '#3b82f6',
        weight: 4,
        opacity: 0.8,
    }).addTo(map);

    map.fitBounds(polyline.getBounds().pad(0.1));
}

onMounted(renderMap);
watch(() => props.geoJson, renderMap, { deep: true });

onUnmounted(() => {
    if (map) {
        map.remove();
        map = null;
    }
});
</script>

<template>
    <div>
        <div ref="mapContainer" class="h-100 w-full rounded-md border" />
        <p v-if="!geoJson" class="mt-2 text-sm text-muted-foreground">
            No geometry data available.
        </p>
    </div>
</template>
