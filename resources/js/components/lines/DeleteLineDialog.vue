<script setup lang="ts">
import { Form } from '@inertiajs/vue3';
import { Trash2 } from '@lucide/vue';
import { computed } from 'vue';
import LineController from '@/actions/App/Http/Controllers/Admin/LineController';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { describeDeleteConsequences } from '@/lib/lineDeletion';
import type { DeletableLine } from '@/lib/lineDeletion';

const props = defineProps<{
    line: DeletableLine;
    /** Whether the opposite direction of the same code exists. */
    hasCounterpart?: boolean;
    /** Whether the page has edits that a delete would throw away. */
    hasUnsavedEdits?: boolean;
    /**
     * The table's current query string, forwarded on the delete request.
     *
     * Not a nicety: the redirect after a delete goes back to the index, and
     * the controller only knows the page to return the reviewer to if the
     * request that deleted the row carried it. A form's action cannot read the
     * address bar, so whoever knows the filters has to hand them over.
     */
    query?: Record<string, string>;
}>();

/**
 * The wording comes from lib/, never from this template.
 *
 * This component is mounted from two surfaces — a row in the index table and
 * the direction card on the edit page — and a delete is irreversible. Two
 * hand-written copies of what the delete takes with it would be two chances to
 * describe it wrongly, so the sentences are derived once and asserted in
 * lineDeletion.test.ts.
 */
const consequences = computed(() =>
    describeDeleteConsequences(props.line, {
        hasCounterpart: props.hasCounterpart,
        hasUnsavedEdits: props.hasUnsavedEdits,
    }),
);
</script>

<template>
    <!--
        Never disabled and never hidden. The codebase's own rule, learned from
        the Delete button in delete mode: an action that is unavailable with no
        stated reason reads as a missing feature. Delete is always available;
        what the reviewer gets instead is a dialog that says exactly what goes.
    -->
    <Dialog>
        <DialogTrigger as-child>
            <Button type="button" variant="destructive" size="sm">
                <Trash2 class="size-4" />
                Delete
            </Button>
        </DialogTrigger>

        <DialogContent>
            <Form
                v-bind="
                    LineController.destroy.form(line.id, {
                        query: props.query,
                    })
                "
                :options="{ preserveScroll: true }"
                v-slot="{ processing }"
            >
                <DialogHeader class="space-y-3">
                    <DialogTitle>{{ consequences.title }}</DialogTitle>
                    <DialogDescription>
                        This cannot be undone.
                        <ul class="mt-2 list-disc space-y-1 pl-4">
                            <li
                                v-for="sentence in consequences.lines"
                                :key="sentence"
                            >
                                {{ sentence }}
                            </li>
                        </ul>
                    </DialogDescription>
                </DialogHeader>

                <DialogFooter class="gap-2">
                    <DialogClose as-child>
                        <Button variant="secondary">Cancel</Button>
                    </DialogClose>

                    <Button
                        type="submit"
                        variant="destructive"
                        :disabled="processing"
                    >
                        Delete
                    </Button>
                </DialogFooter>
            </Form>
        </DialogContent>
    </Dialog>
</template>
