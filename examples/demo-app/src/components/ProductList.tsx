import _ from 'lodash'
import moment from 'moment'
// Fixture file for ExpoPulse. Deliberately contains anti-patterns so the
// analyzer has something to find; do not use any of this as a real example.
import React, { useState, useEffect, useMemo } from 'react'
import { FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native'

interface Product {
  id: string
  title: string
  price: number
  thumbnail: string
}

export function ProductList({ products }: { products: Product[] }) {
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    // require() inside a component body defers module evaluation to render.
    const analytics = require('../lib/analytics')
    analytics.track('list_view')
  }, [])

  const sorted = _.sortBy(products, 'price')

  return (
    <View style={styles.container}>
      <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 12 }}>
        Products ({sorted.length})
      </Text>

      <FlatList
        data={sorted}
        renderItem={({ item }) => (
          <Pressable onPress={() => setSelected(item.id)} style={styles.row}>
            <Image source={{ uri: item.thumbnail }} style={{ width: 64, height: 64 }} />
            <View style={{ flex: 1, paddingLeft: 12 }}>
              <Text style={styles.title}>{item.title}</Text>
              <Text style={{ color: '#888' }}>{moment(Date.now()).format('MMM D, YYYY')}</Text>
            </View>
          </Pressable>
        )}
      />

      {selected ? <Text>Selected: {selected}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  title: { fontSize: 15, fontWeight: '600' },
})
