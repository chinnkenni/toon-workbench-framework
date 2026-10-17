/** Radix listens for Escape on document capture, before the native cancel event. */
export function closeNestedClipSettings(event){
 const dialog=event.target?.closest?.('dialog[data-timeline-native-dialog][open]');
 if(!dialog)return false;
 event.preventDefault();dialog.close();return true;
}
