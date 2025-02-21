/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{html,ts}",
    "./node_modules/flowbite/**/*.js"
  ],
  theme: {
    extend: {
      colors: {
        'netflix-black': '#0d0d0d', // Deep black background
        'netflix-gray': '#141414',  // Slightly lighter black for subtle contrast
        'netflix-red': '#E50914',   // Netflix's signature red
      },
    },
  },
  plugins: [
    require('flowbite/plugin')
  ],
}

