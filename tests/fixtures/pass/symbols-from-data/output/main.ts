export function packFields(id: string, name: string, email: string) {
    return Array.of(id.trim(), name.trim(), email.trim());
}
