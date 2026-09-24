<script setup>
const config = useRuntimeConfig();
const { data } = await useFetch(`${config.apiBase}/api/msg`, { server: true });
</script>
<template>
  <main><h1>Nuxt SSR</h1><p id="msg">{{ data?.msg }} #{{ data?.visits }}</p></main>
</template>
