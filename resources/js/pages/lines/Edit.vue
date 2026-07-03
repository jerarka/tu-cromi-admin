<script setup lang="ts">
import { Form, Head } from '@inertiajs/vue3';
import { computed, ref } from 'vue';
import LineController from '@/actions/App/Http/Controllers/Admin/LineController';
import Heading from '@/components/Heading.vue';
import InputError from '@/components/InputError.vue';
import LineMap from '@/components/lines/LineMap.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Line } from '@/types/line';

const props = defineProps<{
    line: Line;
}>();

const geoJsonText = ref(
    props.line.geo_json
        ? JSON.stringify(props.line.geo_json, null, 2)
        : '',
);

const parsedGeoJson = computed(() => {
    if (!geoJsonText.value) return null;
    try {
        return JSON.parse(geoJsonText.value) as NonNullable<Line['geo_json']>;
    } catch {
        return null;
    }
});

const geoJsonError = ref<string | null>(null);

function validateGeoJson(): void {
    if (!geoJsonText.value) {
        geoJsonError.value = null;
        return;
    }
    try {
        JSON.parse(geoJsonText.value);
        geoJsonError.value = null;
    } catch {
        geoJsonError.value = 'Invalid JSON format.';
    }
}

const pageTitle = computed(
    () => `Edit: ${props.line.code} — ${props.line.sense === 'OUTBOUND' ? 'Ida' : 'Vuelta'}`,
);
</script>

<template>
    <Head :title="pageTitle" />
    <Heading
        :title="pageTitle"
        description="Update line name, color, syndicate, or route geometry"
    />

    <div class="grid gap-8 lg:grid-cols-2">
        <!-- Form -->
        <div>
            <Form
                v-bind="LineController.update.form(line.id)"
                class="space-y-6"
                v-slot="{ errors, processing }"
            >
                <!-- Read-only fields -->
                <div class="grid gap-2">
                    <Label for="code">Code</Label>
                    <Input id="code" :model-value="line.code" disabled class="opacity-60" />
                </div>

                <div class="grid gap-2">
                    <Label for="sense">Direction</Label>
                    <Input id="sense" :model-value="line.sense" disabled class="opacity-60" />
                </div>

                <!-- Editable fields -->
                <div class="grid gap-2">
                    <Label for="name">Name</Label>
                    <Input
                        id="name"
                        name="name"
                        :default-value="line.name ?? ''"
                        placeholder="Line display name"
                    />
                    <InputError :message="errors.name" />
                </div>

                <div class="grid gap-2">
                    <Label for="color">Color</Label>
                    <div class="flex items-center gap-3">
                        <Input
                            id="color"
                            name="color"
                            :default-value="line.color ?? ''"
                            placeholder="#3b82f6"
                            class="w-32"
                        />
                        <span
                            v-if="line.color"
                            class="inline-block h-6 w-6 rounded"
                            :style="{ backgroundColor: line.color }"
                        />
                    </div>
                    <InputError :message="errors.color" />
                </div>

                <div class="grid gap-2">
                    <Label for="syndicate">Syndicate</Label>
                    <Input
                        id="syndicate"
                        name="syndicate"
                        :default-value="line.syndicate ?? ''"
                        placeholder="Operating company"
                    />
                    <InputError :message="errors.syndicate" />
                </div>

                <div class="grid gap-2">
                    <Label for="geo_json">Route geometry (GeoJSON)</Label>
                    <textarea
                        id="geo_json"
                        name="geo_json"
                        class="border-input h-40 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs shadow-xs"
                        :value="geoJsonText"
                        @input="geoJsonText = ($event.target as HTMLTextAreaElement).value; validateGeoJson()"
                        placeholder='{"type":"MultiLineString","coordinates":[[[...]]]}'
                    />
                    <InputError :message="errors.geo_json" />
                    <p v-if="geoJsonError" class="text-sm text-red-600 dark:text-red-500">
                        {{ geoJsonError }}
                    </p>
                </div>

                <div class="flex items-center gap-4">
                    <Button :disabled="processing">Save</Button>
                </div>
            </Form>
        </div>

        <!-- Map preview -->
        <div class="space-y-4">
            <Label>Route preview</Label>
            <LineMap :geo-json="parsedGeoJson" />
            <p v-if="!parsedGeoJson && geoJsonText" class="text-sm text-red-600 dark:text-red-500">
                Fix JSON errors to see the route on the map.
            </p>
        </div>
    </div>
</template>
