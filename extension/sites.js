// Per-site form hints. Sites change their markup often: each field lists several
// candidate selectors, and the filler falls back to matching label/placeholder
// text. If a site redesign breaks a field, update its selectors here.
self.FLIPDESK_SITES = {
  poshmark: {
    title: ['input[data-vv-name="title"]', 'input[placeholder*="What are you selling"]'],
    description: ['textarea[data-vv-name="description"]', 'textarea[placeholder*="Describe"]'],
    price: ['input[data-vv-name="listingPrice"]', 'input[data-vv-name="price"]'],
    originalPrice: ['input[data-vv-name="originalPrice"]'],
    brand: ['input[placeholder*="Brand"]'],
    photos: ['input[type="file"]'],
    successUrl: /poshmark\.com\/listing\//,
  },
  mercari: {
    title: ['input[data-testid="Title"]', 'input[name="name"]'],
    description: ['textarea[data-testid="Description"]', 'textarea[name="description"]'],
    price: ['input[data-testid="Price"]', 'input[name="price"]'],
    brand: ['input[data-testid="Brand"]'],
    photos: ['input[type="file"]'],
    successUrl: /mercari\.com\/(us\/)?item\/m\d+/,
  },
  depop: {
    description: ['textarea[name="description"]', 'textarea#description'],
    price: ['input[name="price"]', 'input#price'],
    brand: ['input[name="brand"]'],
    photos: ['input[type="file"]'],
    successUrl: /depop\.com\/products\/(?!create)/,
  },
  vinted: {
    title: ['input[name="title"]', 'input#title'],
    description: ['textarea[name="description"]', 'textarea#description'],
    price: ['input[name="price"]', 'input#price'],
    photos: ['input[type="file"]'],
    successUrl: /vinted\.com\/items\/\d+/,
  },
  grailed: {
    title: ['input[name="title"]'],
    description: ['textarea[name="description"]'],
    price: ['input[name="price"]'],
    brand: ['input[name="designer"]', 'input[placeholder*="Designer"]'],
    photos: ['input[type="file"]'],
    titleMax: 60,
    successUrl: /grailed\.com\/listings\/\d+/,
  },
  facebook: {
    title: ['label[aria-label="Title"] input', 'input[aria-label="Title"]'],
    description: ['label[aria-label="Description"] textarea', 'textarea[aria-label="Description"]'],
    price: ['label[aria-label="Price"] input', 'input[aria-label="Price"]'],
    photos: ['input[type="file"][accept*="image"]'],
    successUrl: /facebook\.com\/marketplace\/(item|you\/selling)/,
  },
  whatnot: {
    title: ['input[name="title"]'],
    description: ['textarea[name="description"]'],
    price: ['input[name="price"]'],
    quantity: ['input[name="quantity"]'],
    photos: ['input[type="file"]'],
    successUrl: /whatnot\.com\/(dashboard\/inventory|listing)\/(?!new)/,
  },
};
